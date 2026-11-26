import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { EmailAuthService } from './email-auth.service';

// Hand-rolled fakes rather than a Nest TestingModule — mirrors the pattern
// used elsewhere in this repo (see market.service.spec.ts) for keeping unit
// tests fast and independent of the real Stellar SDK / relay.

function config(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    emailCodeResendCooldownSecs: 60,
    emailCodeTtlSecs: 600,
    emailCodeMaxAttempts: 5,
    sessionJwtSecret: 'test-session-secret',
    sessionTtlSecs: 3600,
    smartWalletFactoryContract: 'FACTORY',
    smartWalletWasmHash: '00'.repeat(32),
    emailWalletEncKeyHex: '11'.repeat(32),
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function pendingCodeRepo(email: string, code: string) {
  const codeHash = createHash('sha256').update(code).digest('hex');
  return {
    getCode: jest.fn().mockReturnValue({
      email,
      code_hash: codeHash,
      expires_at: Date.now() + 10_000,
      attempts: 0,
      created_at: Date.now(),
    }),
    deleteCode: jest.fn(),
    incrementAttempts: jest.fn(),
    getWallet: jest.fn().mockReturnValue(undefined),
    saveWallet: jest.fn(),
  };
}

describe('EmailAuthService — auto-funding a freshly created wallet', () => {
  // Regression for: a brand-new custodial wallet deploys on-chain with 0
  // XLM, and `buy` pulls its collateral straight from the wallet's own
  // balance — without this, every first-time email login's very first
  // trade failed on an opaque "insufficient balance" simulation error.
  it('funds a newly deployed wallet via the faucet', async () => {
    const email = 'bettor@example.com';
    const code = '654321';
    const repo = pendingCodeRepo(email, code);
    const stellar = { deployWallet: jest.fn().mockResolvedValue('CNEWWALLETADDRESS') };
    const relay = {};
    const faucet = {
      tryConsume: jest.fn().mockReturnValue(true),
      fund: jest.fn().mockResolvedValue({ funded: true, alreadyExists: false }),
    };
    const sender = { send: jest.fn() };

    const svc = new EmailAuthService(
      config(),
      repo as any,
      stellar as any,
      relay as any,
      faucet as any,
      sender as any,
    );

    const result = await svc.verifyCode(email, code);

    expect(result.address).toBe('CNEWWALLETADDRESS');
    expect(faucet.tryConsume).toHaveBeenCalledWith('CNEWWALLETADDRESS');
    expect(faucet.fund).toHaveBeenCalledWith('CNEWWALLETADDRESS');
  });

  it('does not fail login if the faucet is down', async () => {
    const email = 'bettor2@example.com';
    const code = '111222';
    const repo = pendingCodeRepo(email, code);
    const stellar = { deployWallet: jest.fn().mockResolvedValue('CNEWWALLETADDRESS2') };
    const relay = {};
    const faucet = {
      tryConsume: jest.fn().mockReturnValue(true),
      fund: jest.fn().mockRejectedValue(new Error('friendbot funding failed: 503')),
    };
    const sender = { send: jest.fn() };

    const svc = new EmailAuthService(
      config(),
      repo as any,
      stellar as any,
      relay as any,
      faucet as any,
      sender as any,
    );

    await expect(svc.verifyCode(email, code)).resolves.toMatchObject({ address: 'CNEWWALLETADDRESS2' });
  });

  it('does not re-fund or re-deploy for a returning email login', async () => {
    const email = 'returning@example.com';
    const code = '999888';
    const repo = pendingCodeRepo(email, code);
    repo.getWallet.mockReturnValue({
      email,
      address: 'CEXISTINGWALLET',
      public_key_hex: 'ab',
      encrypted_private_key: 'ciphertext',
      created_at: Date.now(),
    });
    const stellar = { deployWallet: jest.fn() };
    const relay = {};
    const faucet = { tryConsume: jest.fn(), fund: jest.fn() };
    const sender = { send: jest.fn() };

    const svc = new EmailAuthService(
      config(),
      repo as any,
      stellar as any,
      relay as any,
      faucet as any,
      sender as any,
    );

    const result = await svc.verifyCode(email, code);

    expect(result.address).toBe('CEXISTINGWALLET');
    expect(stellar.deployWallet).not.toHaveBeenCalled();
    expect(faucet.tryConsume).not.toHaveBeenCalled();
  });
});

describe('EmailAuthService — verifyCode', () => {
  const email = 'bettor@example.com';
  const sha = (c: string) => createHash('sha256').update(c).digest('hex');

  // In-memory stand-in for EmailAuthRepository so state changes are observable.
  function setup(row?: { code: string; expiresInMs?: number; attempts?: number }) {
    const codes = new Map<string, any>();
    const wallets = new Map<string, any>();
    if (row) {
      codes.set(email, {
        email,
        code_hash: sha(row.code),
        expires_at: Date.now() + (row.expiresInMs ?? 10_000),
        attempts: row.attempts ?? 0,
        created_at: Date.now(),
      });
    }
    const repo = {
      getCode: (e: string) => codes.get(e),
      deleteCode: (e: string) => void codes.delete(e),
      incrementAttempts: (e: string) => {
        const r = codes.get(e);
        if (r) r.attempts += 1;
      },
      getWallet: (e: string) => wallets.get(e),
      saveWallet: (e: string, address: string) => void wallets.set(e, { email: e, address }),
    };
    const stellar = { deployWallet: jest.fn().mockResolvedValue('CNEWWALLET') };
    const faucet = { tryConsume: jest.fn().mockReturnValue(false), fund: jest.fn() };
    const svc = new EmailAuthService(config(), repo as any, stellar as any, {} as any, faucet as any, {} as any);
    return { svc, codes, stellar };
  }

  it('rejects an email with no pending code', async () => {
    const { svc } = setup();
    await expect(svc.verifyCode(email, '123456')).rejects.toThrow('No code was requested');
  });

  it('rejects and deletes the code once attempts hit the max', async () => {
    const { svc, codes } = setup({ code: '123456', attempts: 5 });
    await expect(svc.verifyCode(email, '123456')).rejects.toThrow('Too many incorrect attempts');
    expect(codes.has(email)).toBe(false);
  });

  it('rejects and deletes an expired code', async () => {
    const { svc, codes } = setup({ code: '123456', expiresInMs: -1000 });
    await expect(svc.verifyCode(email, '123456')).rejects.toThrow('expired');
    expect(codes.has(email)).toBe(false);
  });

  it('rejects a wrong code, increments attempts and keeps the row', async () => {
    const { svc, codes } = setup({ code: '123456' });
    await expect(svc.verifyCode(email, '000000')).rejects.toThrow('Incorrect code');
    expect(codes.get(email).attempts).toBe(1);
  });

  it('accepts the right code once: deletes the row, deploys one wallet, issues a verifiable session', async () => {
    const { svc, codes, stellar } = setup({ code: '123456' });
    const { address, sessionToken } = await svc.verifyCode(email, '123456');
    expect(codes.has(email)).toBe(false);
    expect(stellar.deployWallet).toHaveBeenCalledTimes(1);
    expect(svc.verifySession(sessionToken)).toEqual({ email, address });
  });

  it('rejects replaying the same code after success', async () => {
    const { svc, stellar } = setup({ code: '123456' });
    await svc.verifyCode(email, '123456');
    await expect(svc.verifyCode(email, '123456')).rejects.toThrow('No code was requested');
    expect(stellar.deployWallet).toHaveBeenCalledTimes(1);
  });
});

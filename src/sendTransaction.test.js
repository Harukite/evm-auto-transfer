const test = require("node:test");
const assert = require("node:assert");
const { ethers } = require("ethers");

const sendWithRetry = require("./sendTransaction");
const { classifyError } = sendWithRetry;

const TEST_PRIVATE_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

function makeWallet(provider) {
  const signer = new ethers.Wallet(TEST_PRIVATE_KEY);
  return {
    provider,
    signTransaction: (tx) => signer.signTransaction(tx),
  };
}

function makeProvider({ broadcast, waitFor }) {
  return {
    broadcastTransaction: broadcast,
    waitForTransaction: waitFor || (async (hash) => ({ hash, status: 1 })),
  };
}

function legacyTx(overrides = {}) {
  return {
    to: ethers.ZeroAddress,
    value: 1n,
    gasLimit: 21000n,
    gasPrice: 1_000_000_000n,
    nonce: 5,
    chainId: 1,
    ...overrides,
  };
}

function eip1559Tx(overrides = {}) {
  return {
    to: ethers.ZeroAddress,
    value: 1n,
    gasLimit: 21000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    nonce: 5,
    chainId: 1,
    ...overrides,
  };
}

function underpricedError() {
  const err = new Error("replacement fee too low");
  err.code = "REPLACEMENT_UNDERPRICED";
  return err;
}

function nonceStaleError() {
  const err = new Error("nonce too low");
  err.code = "NONCE_EXPIRED";
  return err;
}

function alreadyKnownError() {
  return new Error("already known");
}

test("classifyError does not treat already-known as nonce-stale", () => {
  const c = classifyError(alreadyKnownError());
  assert.equal(c.isAlreadyKnown, true);
  assert.equal(c.isNonceStale, false);
  assert.equal(c.isUnderpriced, false);
});

test("classifyError routes REPLACEMENT_UNDERPRICED to isUnderpriced", () => {
  const c = classifyError(underpricedError());
  assert.equal(c.isUnderpriced, true);
  assert.equal(c.isAlreadyKnown, false);
});

test("classifyError routes NONCE_EXPIRED to isNonceStale", () => {
  const c = classifyError(nonceStaleError());
  assert.equal(c.isNonceStale, true);
  assert.equal(c.isAlreadyKnown, false);
});

test("succeeds on first attempt and returns nextNonce = nonce + 1", async () => {
  let calls = 0;
  const provider = makeProvider({
    broadcast: async (signed) => {
      calls++;
      return { hash: ethers.Transaction.from(signed).hash };
    },
  });
  const wallet = makeWallet(provider);

  const result = await sendWithRetry(wallet, legacyTx({ nonce: 5 }), {
    maxRetries: 3,
    delay: 1,
  });

  assert.equal(calls, 1);
  assert.equal(result.nextNonce, 6);
  assert.ok(result.response.hash);
});

test("bumps legacy gasPrice on REPLACEMENT_UNDERPRICED and keeps nonce", async () => {
  let calls = 0;
  const gasPrices = [];
  const provider = makeProvider({
    broadcast: async (signed) => {
      calls++;
      const parsed = ethers.Transaction.from(signed);
      gasPrices.push(parsed.gasPrice);
      if (calls === 1) throw underpricedError();
      return { hash: parsed.hash };
    },
  });
  const wallet = makeWallet(provider);

  const result = await sendWithRetry(wallet, legacyTx({ nonce: 5 }), {
    maxRetries: 3,
    delay: 1,
  });

  assert.equal(calls, 2);
  assert.ok(gasPrices[1] > gasPrices[0], "gasPrice must be bumped");
  assert.equal(result.nextNonce, 6, "nonce must not be bumped on underpriced");
});

test("bumps EIP-1559 fees on REPLACEMENT_UNDERPRICED", async () => {
  let calls = 0;
  const observed = [];
  const provider = makeProvider({
    broadcast: async (signed) => {
      calls++;
      const parsed = ethers.Transaction.from(signed);
      observed.push({
        maxFeePerGas: parsed.maxFeePerGas,
        maxPriorityFeePerGas: parsed.maxPriorityFeePerGas,
      });
      if (calls === 1) throw underpricedError();
      return { hash: parsed.hash };
    },
  });
  const wallet = makeWallet(provider);

  const result = await sendWithRetry(wallet, eip1559Tx({ nonce: 5 }), {
    maxRetries: 3,
    delay: 1,
  });

  assert.equal(calls, 2);
  assert.ok(observed[1].maxFeePerGas > observed[0].maxFeePerGas);
  assert.ok(observed[1].maxPriorityFeePerGas > observed[0].maxPriorityFeePerGas);
  assert.equal(result.nextNonce, 6);
});

test("bumps nonce on NONCE_EXPIRED and reports nextNonce accurately", async () => {
  let calls = 0;
  const noncesSeen = [];
  const provider = makeProvider({
    broadcast: async (signed) => {
      calls++;
      const parsed = ethers.Transaction.from(signed);
      noncesSeen.push(parsed.nonce);
      if (calls === 1) throw nonceStaleError();
      return { hash: parsed.hash };
    },
  });
  const wallet = makeWallet(provider);

  const result = await sendWithRetry(wallet, legacyTx({ nonce: 5 }), {
    maxRetries: 3,
    delay: 1,
  });

  assert.deepEqual(noncesSeen, [5, 6]);
  assert.equal(
    result.nextNonce,
    7,
    "after internal bump to nonce=6, nextNonce must be 7 so caller does not collide"
  );
});

test("treats already-known as success without retry or double-send", async () => {
  let calls = 0;
  let expectedHash;
  const provider = makeProvider({
    broadcast: async (signed) => {
      calls++;
      expectedHash = ethers.Transaction.from(signed).hash;
      throw alreadyKnownError();
    },
  });
  const wallet = makeWallet(provider);

  const result = await sendWithRetry(wallet, legacyTx({ nonce: 5 }), {
    maxRetries: 3,
    delay: 1,
  });

  assert.equal(calls, 1, "must not retry on already-known");
  assert.equal(result.response.hash, expectedHash);
  assert.equal(result.nextNonce, 6, "nonce advances normally, not double-bumped");
});

test("throws the last error after exhausting maxRetries", async () => {
  let calls = 0;
  const provider = makeProvider({
    broadcast: async () => {
      calls++;
      throw new Error("persistent network failure");
    },
  });
  const wallet = makeWallet(provider);

  await assert.rejects(
    () =>
      sendWithRetry(wallet, legacyTx(), {
        maxRetries: 3,
        delay: 1,
      }),
    /persistent network failure/
  );
  assert.equal(calls, 3);
});

const { ethers } = require("ethers");
const colors = require("colors");
const sleep = require("./sleep");

const GAS_BUMP_NUMERATOR = 125n;
const GAS_BUMP_DENOMINATOR = 100n;

function classifyError(error) {
  const rpcMessage = (
    error?.info?.error?.message ||
    error?.shortMessage ||
    error?.message ||
    ""
  ).toLowerCase();
  const code = error?.code;

  const isAlreadyKnown =
    rpcMessage.includes("already known") || rpcMessage.includes("already imported");

  const isUnderpriced =
    !isAlreadyKnown &&
    (code === "REPLACEMENT_UNDERPRICED" ||
      rpcMessage.includes("replacement") ||
      rpcMessage.includes("underpriced") ||
      rpcMessage.includes("fee too low"));

  const isNonceStale =
    !isAlreadyKnown &&
    (code === "NONCE_EXPIRED" || rpcMessage.includes("nonce too low"));

  return { isAlreadyKnown, isUnderpriced, isNonceStale, code };
}

function bumpFees(tx) {
  if (tx.maxFeePerGas != null) {
    tx.maxFeePerGas = (BigInt(tx.maxFeePerGas) * GAS_BUMP_NUMERATOR) / GAS_BUMP_DENOMINATOR;
  }
  if (tx.maxPriorityFeePerGas != null) {
    tx.maxPriorityFeePerGas =
      (BigInt(tx.maxPriorityFeePerGas) * GAS_BUMP_NUMERATOR) / GAS_BUMP_DENOMINATOR;
  }
  if (tx.gasPrice != null) {
    tx.gasPrice = (BigInt(tx.gasPrice) * GAS_BUMP_NUMERATOR) / GAS_BUMP_DENOMINATOR;
  }
}

function describeFee(tx) {
  if (tx.maxFeePerGas != null) {
    return `maxFee ${ethers.formatUnits(tx.maxFeePerGas, "gwei")} gwei`;
  }
  if (tx.gasPrice != null) {
    return `gasPrice ${ethers.formatUnits(tx.gasPrice, "gwei")} gwei`;
  }
  return "unknown fee";
}

function buildAlreadyKnownResponse(provider, hash) {
  return {
    hash,
    wait: async (confirmations = 1, timeoutMs = 60000) =>
      provider.waitForTransaction(hash, confirmations, timeoutMs),
  };
}

async function sendWithRetry(wallet, txRequest, { maxRetries = 5, delay = 5000 } = {}) {
  const tx = { ...txRequest };
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const signed = await wallet.signTransaction(tx);
      const expectedHash = ethers.Transaction.from(signed).hash;

      try {
        const response = await wallet.provider.broadcastTransaction(signed);
        return { response, nextNonce: tx.nonce + 1 };
      } catch (broadcastError) {
        const { isAlreadyKnown, isUnderpriced, isNonceStale, code } =
          classifyError(broadcastError);

        if (isAlreadyKnown) {
          console.log(
            colors.yellow(
              `ℹ️ Transaction at nonce ${tx.nonce} already in mempool: ${expectedHash}`
            )
          );
          return {
            response: buildAlreadyKnownResponse(wallet.provider, expectedHash),
            nextNonce: tx.nonce + 1,
          };
        }

        if (isNonceStale) {
          tx.nonce += 1;
          console.log(
            colors.yellow(
              `⚠️ Nonce stale, bumping to ${tx.nonce} (attempt ${attempt}/${maxRetries})`
            )
          );
        } else if (isUnderpriced) {
          bumpFees(tx);
          console.log(
            colors.yellow(
              `⚠️ Replacement underpriced, bumping ${describeFee(tx)} (attempt ${attempt}/${maxRetries})`
            )
          );
        } else {
          console.log(
            colors.yellow(
              `⚠️ Send failed (${code || "unknown"}). Retrying... (${attempt}/${maxRetries})`
            )
          );
        }

        lastError = broadcastError;
      }
    } catch (error) {
      lastError = error;
      console.log(
        colors.yellow(
          `⚠️ Sign/send error: ${error?.shortMessage || error?.message || "unknown"} (attempt ${attempt}/${maxRetries})`
        )
      );
    }

    if (attempt < maxRetries) await sleep(delay);
  }

  throw lastError;
}

module.exports = sendWithRetry;
module.exports.classifyError = classifyError;

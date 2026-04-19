const { ethers } = require("ethers");
const colors = require("colors");
const sleep = require("./sleep");

const GAS_BUMP_NUMERATOR = 125n;
const GAS_BUMP_DENOMINATOR = 100n;

async function sendWithRetry(wallet, txRequest, { maxRetries = 5, delay = 5000 } = {}) {
  const tx = { ...txRequest };
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await wallet.sendTransaction(tx);
    } catch (error) {
      lastError = error;
      const rpcMessage = (
        error?.info?.error?.message ||
        error?.shortMessage ||
        error?.message ||
        ""
      ).toLowerCase();
      const code = error?.code;

      const isUnderpriced =
        code === "REPLACEMENT_UNDERPRICED" ||
        rpcMessage.includes("replacement") ||
        rpcMessage.includes("underpriced") ||
        rpcMessage.includes("fee too low");

      const isNonceStale =
        code === "NONCE_EXPIRED" ||
        rpcMessage.includes("nonce too low") ||
        rpcMessage.includes("already known") ||
        rpcMessage.includes("already imported");

      if (isNonceStale && tx.nonce !== undefined) {
        tx.nonce += 1;
        console.log(
          colors.yellow(
            `⚠️ Nonce stale, bumping to ${tx.nonce} (attempt ${attempt}/${maxRetries})`
          )
        );
      } else if (isUnderpriced && tx.gasPrice) {
        tx.gasPrice = (BigInt(tx.gasPrice) * GAS_BUMP_NUMERATOR) / GAS_BUMP_DENOMINATOR;
        console.log(
          colors.yellow(
            `⚠️ Replacement underpriced, bumping gas to ${ethers.formatUnits(
              tx.gasPrice,
              "gwei"
            )} gwei (attempt ${attempt}/${maxRetries})`
          )
        );
      } else {
        console.log(
          colors.yellow(
            `⚠️ Send failed (${code || "unknown"}). Retrying... (${attempt}/${maxRetries})`
          )
        );
      }

      if (attempt < maxRetries) await sleep(delay);
    }
  }

  throw lastError;
}

module.exports = sendWithRetry;

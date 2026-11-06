import { getAddress, isAddress } from "viem";

/** The only chain and token the bounty qualifies on. */
export const QUALIFYING_CHAIN_ID = 1874;
/** Official Whitechain test USDT (checksummed). */
export const QUALIFYING_USDT = getAddress("0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7");

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Library guard for startup: throws unless the chain is 1874 and the token is the official USDT
 * (address compared case-insensitively). Returns the checksummed token address.
 * Wiring this into the relayer and apps is their job (see docs/lead/shared-change.md).
 */
export function assertQualifyingConfig(config: { chainId: number | string | bigint; tokenAddress: string }): `0x${string}` {
  if (Number(config.chainId) !== QUALIFYING_CHAIN_ID) {
    throw new ConfigError(`Wrong chain: expected ${QUALIFYING_CHAIN_ID}, got ${String(config.chainId)}`);
  }
  if (!isAddress(config.tokenAddress, { strict: false }) || config.tokenAddress.toLowerCase() !== QUALIFYING_USDT.toLowerCase()) {
    throw new ConfigError(`Wrong token: expected the official USDT ${QUALIFYING_USDT}, got ${config.tokenAddress}`);
  }
  return QUALIFYING_USDT;
}

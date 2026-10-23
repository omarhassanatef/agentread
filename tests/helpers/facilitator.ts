import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { verifyTypedData, type Hex } from "viem";

export const FACILITATOR_ADDRESS = "0x9999999999999999999999999999999999999999" as const;
/** Circle USDC on Base Sepolia — the only address with contract code on the mock chain. */
export const MOCK_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

/**
 * A fake EVM chain for the *real* @x402/evm facilitator scheme. Signature checks,
 * amount/recipient/expiry validation and replay protection all run in the SDK;
 * only chain reads/writes are simulated here.
 */
export class MockChain {
  usedNonces = new Set<string>();
  settlements: Array<{ from: string; to: string; value: bigint; nonce: string; tx: Hex }> = [];
  /** "revert": tx mined but failed. "throw": RPC error when broadcasting. */
  settleMode: "ok" | "revert" | "throw" = "ok";
  balance = 1_000_000_000n;
  private receipts = new Map<string, string>();
  private txCounter = 0;

  signer() {
    return {
      getAddresses: () => [FACILITATOR_ADDRESS] as const,
      readContract: async (args: { address: Hex; functionName: string; args?: readonly unknown[] }) => {
        switch (args.functionName) {
          case "balanceOf":
            return this.balance;
          case "authorizationState":
            return this.usedNonces.has(String(args.args?.[1]));
          case "transferWithAuthorization": {
            // eth_call simulation
            const nonce = String(args.args?.[5]);
            if (this.usedNonces.has(nonce)) throw new Error("FiatTokenV2: authorization is used or canceled");
            return undefined;
          }
          case "name":
            return "USDC";
          case "version":
            return "2";
          case "decimals":
            return 6;
          default:
            throw new Error(`MockChain: unexpected readContract(${args.functionName})`);
        }
      },
      verifyTypedData: async (args: Parameters<typeof verifyTypedData>[0]) => verifyTypedData(args as never),
      writeContract: async (args: { functionName: string; args: readonly unknown[] }) => {
        if (this.settleMode === "throw") throw new Error("MockChain: RPC unavailable");
        const [from, to, value, , , nonce] = args.args as [string, string, bigint, bigint, bigint, string];
        if (this.usedNonces.has(String(nonce))) throw new Error("FiatTokenV2: authorization is used or canceled");
        const tx = `0x${(++this.txCounter).toString(16).padStart(64, "0")}` as Hex;
        if (this.settleMode === "revert") {
          this.receipts.set(tx, "reverted");
        } else {
          this.usedNonces.add(String(nonce));
          this.receipts.set(tx, "success");
          this.settlements.push({ from, to, value: BigInt(value), nonce: String(nonce), tx });
        }
        return tx;
      },
      sendTransaction: async () => {
        throw new Error("MockChain: sendTransaction not supported");
      },
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: this.receipts.get(hash) ?? "reverted" }),
      // Payers are EOAs (no code), so the SDK verifies ECDSA signatures rather than ERC-1271.
      getCode: async ({ address }: { address: Hex }) => (address.toLowerCase() === MOCK_USDC ? "0x6080604052" : "0x"),
    };
  }
}

/** In-process FacilitatorClient backed by the real x402Facilitator + EVM exact scheme. */
export class LocalFacilitator implements FacilitatorClient {
  readonly chain = new MockChain();
  readonly facilitator: x402Facilitator;
  calls = { verify: 0, settle: 0, supported: 0 };
  supportedFails = false;

  constructor(network = "eip155:84532") {
    this.facilitator = new x402Facilitator().register(network as never, new ExactEvmScheme(this.chain.signer() as never));
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.calls.verify++;
    return this.facilitator.verify(payload, requirements);
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.calls.settle++;
    return this.facilitator.settle(payload, requirements);
  }

  async getSupported(): Promise<SupportedResponse> {
    this.calls.supported++;
    if (this.supportedFails) throw new Error("facilitator unreachable");
    return this.facilitator.getSupported() as SupportedResponse;
  }
}

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

export const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

export interface SolanaOptions {
  rpcUrl?: string;
  /** Optional commitment level: 'processed' | 'confirmed' | 'finalized' */
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

export class SolanaHelper {
  public readonly connection: Connection;
  public readonly rpcUrl: string;

  constructor(opts: SolanaOptions = {}) {
    this.rpcUrl = opts.rpcUrl ?? DEFAULT_SOLANA_RPC;
    this.connection = new Connection(this.rpcUrl, opts.commitment ?? 'confirmed');
  }

  async getSolBalance(address: string): Promise<{ address: string; lamports: number; sol: number }> {
    const pk = new PublicKey(address);
    const lamports = await this.connection.getBalance(pk);
    return {
      address,
      lamports,
      sol: lamports / LAMPORTS_PER_SOL,
    };
  }

  async getSplTokenBalance(
    owner: string,
    mint: string,
  ): Promise<{
    owner: string;
    mint: string;
    amount: string;
    decimals: number;
    uiAmount: number | null;
  }> {
    const ownerPk = new PublicKey(owner);
    const mintPk = new PublicKey(mint);
    // Lazy-load the token program to keep cold start fast.
    const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
    const resp = await this.connection.getParsedTokenAccountsByOwner(ownerPk, {
      mint: mintPk,
      programId: TOKEN_PROGRAM_ID,
    });
    const total = resp.value.reduce((acc, acct) => {
      const info = acct.account.data.parsed.info;
      return acc + Number(info.tokenAmount.amount);
    }, 0);
    const decimals = resp.value[0]?.account.data.parsed.info.tokenAmount.decimals ?? 0;
    const uiAmount = resp.value[0]?.account.data.parsed.info.tokenAmount.uiAmount ?? null;
    return {
      owner,
      mint,
      amount: String(total),
      decimals,
      uiAmount,
    };
  }
}

/** Convenience: get-or-create singleton Solana helper. */
let singleton: SolanaHelper | undefined;
export function getConnection(opts?: SolanaOptions): SolanaHelper {
  if (!singleton) singleton = new SolanaHelper(opts);
  return singleton;
}

export function resetConnection(): void {
  singleton = undefined;
}
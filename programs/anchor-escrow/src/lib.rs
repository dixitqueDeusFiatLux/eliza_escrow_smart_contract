use anchor_lang::prelude::*;
mod contexts;
use contexts::*;
mod states;

declare_id!("7xPuVJEKsK3Y7fTbDVhVgzBmHrzfATQSerpsyKe3aMma");

#[program]
pub mod anchor_escrow {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        seed: u64,
        initializer_amount: u64,
        taker_amount: u64,
        taker: Pubkey,
    ) -> Result<()> {
        ctx.accounts.initialize_escrow(seed, &ctx.bumps, initializer_amount, taker_amount, taker)
    }

    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        ctx.accounts.refund_and_close_vaults()
    }

    pub fn exchange(ctx: Context<Exchange>) -> Result<()> {
        ctx.accounts.execute_exchange()
    }
}

#[error_code]
pub enum ErrorCode {
    #[msg("Insufficient tokens in taker's vault - must be at least 95% of requested amount")]
    InsufficientTakerTokens,
}

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{
        close_account, transfer_checked, CloseAccount, Mint, Token, TokenAccount, TransferChecked,
    },
};

use crate::states::Escrow;

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    signer: Signer<'info>,
    #[account(
        mut,
        constraint = signer.key() == escrow.initializer || signer.key() == escrow.taker
    )]
    initializer: SystemAccount<'info>,
    taker: SystemAccount<'info>,
    mint_a: Account<'info, Mint>,
    mint_b: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = initializer
    )]
    initializer_ata_a: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = mint_b,
        associated_token::authority = taker
    )]
    taker_ata_b: Account<'info, TokenAccount>,
    #[account(
        mut,
        has_one = initializer,
        has_one = taker,
        has_one = mint_a,
        has_one = mint_b,
        close = initializer,
        seeds=[b"state", escrow.seed.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    escrow: Account<'info, Escrow>,
    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = escrow
    )]
    vault_a: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::authority = escrow
    )]
    vault_b: Account<'info, TokenAccount>,
    associated_token_program: Program<'info, AssociatedToken>,
    token_program: Program<'info, Token>,
    system_program: Program<'info, System>,
}

impl<'info> Cancel<'info> {
    pub fn refund_and_close_vaults(&mut self) -> Result<()> {
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"state",
            &self.escrow.seed.to_le_bytes()[..],
            &[self.escrow.bump],
        ]];

        if self.vault_a.amount > 0 {
            transfer_checked(
                self.into_refund_a_context().with_signer(&signer_seeds),
                self.vault_a.amount,
                self.mint_a.decimals,
            )?;
        }

        if self.vault_b.amount > 0 {
            transfer_checked(
                self.into_refund_b_context().with_signer(&signer_seeds),
                self.vault_b.amount,
                self.mint_b.decimals,
            )?;
        }

        close_account(self.into_close_a_context().with_signer(&signer_seeds))?;
        close_account(self.into_close_b_context().with_signer(&signer_seeds))
    }

    fn into_refund_a_context(&self) -> CpiContext<'_, '_, '_, 'info, TransferChecked<'info>> {
        let cpi_accounts = TransferChecked {
            from: self.vault_a.to_account_info(),
            mint: self.mint_a.to_account_info(),
            to: self.initializer_ata_a.to_account_info(),
            authority: self.escrow.to_account_info(),
        };
        CpiContext::new(self.token_program.to_account_info(), cpi_accounts)
    }

    fn into_refund_b_context(&self) -> CpiContext<'_, '_, '_, 'info, TransferChecked<'info>> {
        let cpi_accounts = TransferChecked {
            from: self.vault_b.to_account_info(),
            mint: self.mint_b.to_account_info(),
            to: self.taker_ata_b.to_account_info(),
            authority: self.escrow.to_account_info(),
        };
        CpiContext::new(self.token_program.to_account_info(), cpi_accounts)
    }

    fn into_close_a_context(&self) -> CpiContext<'_, '_, '_, 'info, CloseAccount<'info>> {
        let cpi_accounts = CloseAccount {
            account: self.vault_a.to_account_info(),
            destination: self.initializer.to_account_info(),
            authority: self.escrow.to_account_info(),
        };
        CpiContext::new(self.token_program.to_account_info(), cpi_accounts)
    }

    fn into_close_b_context(&self) -> CpiContext<'_, '_, '_, 'info, CloseAccount<'info>> {
        let cpi_accounts = CloseAccount {
            account: self.vault_b.to_account_info(),
            destination: self.initializer.to_account_info(),
            authority: self.escrow.to_account_info(),
        };
        CpiContext::new(self.token_program.to_account_info(), cpi_accounts)
    }
}

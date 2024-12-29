use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{
        close_account, transfer_checked, CloseAccount, Mint, Token, TokenAccount, TransferChecked,
    },
};

use crate::{states::Escrow, ErrorCode};

#[derive(Accounts)]
pub struct Exchange<'info> {
    #[account(mut)]
    pub initializer: Signer<'info>,
    pub taker: SystemAccount<'info>,
    pub mint_a: Box<Account<'info, Mint>>,
    pub mint_b: Box<Account<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = initializer
    )]
    pub initializer_ata_a: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = initializer,
        associated_token::mint = mint_b,
        associated_token::authority = initializer
    )]
    pub initializer_ata_b: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = initializer,
        associated_token::mint = mint_a,
        associated_token::authority = taker
    )]
    pub taker_ata_a: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::authority = taker
    )]
    pub taker_ata_b: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        has_one = mint_a,
        has_one = mint_b,
        has_one = initializer,
        close = initializer,
        seeds=[b"state", escrow.seed.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Box<Account<'info, Escrow>>,
    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = escrow
    )]
    pub vault_a: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::authority = escrow
    )]
    pub vault_b: Box<Account<'info, TokenAccount>>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> Exchange<'info> {
    pub fn execute_exchange(&mut self) -> Result<()> {
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"state",
            &self.escrow.seed.to_le_bytes()[..],
            &[self.escrow.bump],
        ]];

        // Calculate minimum acceptable amount (95% of specified amount)
        let min_acceptable_amount = self.escrow.taker_amount
            .checked_mul(95)
            .unwrap()
            .checked_div(100)
            .unwrap();

        // Check if vault_b has enough tokens (at least 95% of specified amount)
        require!(
            self.vault_b.amount >= min_acceptable_amount,
            crate::ErrorCode::InsufficientTakerTokens
        );

        // Transfer tokens from vault_a to taker_ata_a
        transfer_checked(
            self.into_transfer_a_context().with_signer(&signer_seeds),
            self.escrow.initializer_amount,
            self.mint_a.decimals,
        )?;

        // Transfer actual amount from vault_b to initializer_ata_b
        transfer_checked(
            self.into_transfer_b_context().with_signer(&signer_seeds),
            self.vault_b.amount, // Use actual vault amount instead of escrow.taker_amount
            self.mint_b.decimals,
        )?;

        // Close both vaults
        close_account(self.into_close_a_context().with_signer(&signer_seeds))?;
        close_account(self.into_close_b_context().with_signer(&signer_seeds))
    }

    fn into_transfer_a_context(&self) -> CpiContext<'_, '_, '_, 'info, TransferChecked<'info>> {
        let cpi_accounts = TransferChecked {
            from: self.vault_a.to_account_info(),
            mint: self.mint_a.to_account_info(),
            to: self.taker_ata_a.to_account_info(),
            authority: self.escrow.to_account_info(),
        };
        CpiContext::new(self.token_program.to_account_info(), cpi_accounts)
    }

    fn into_transfer_b_context(&self) -> CpiContext<'_, '_, '_, 'info, TransferChecked<'info>> {
        let cpi_accounts = TransferChecked {
            from: self.vault_b.to_account_info(),
            mint: self.mint_b.to_account_info(),
            to: self.initializer_ata_b.to_account_info(),
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

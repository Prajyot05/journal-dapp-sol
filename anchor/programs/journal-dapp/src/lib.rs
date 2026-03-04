use anchor_lang::prelude::*;

#[cfg(test)]
mod tests;

declare_id!("4HRxGm7uKwqbDXz7Ywt8FeGtx7GovKMqUGQpEBtiWapc");

/*
    The newest versions of Rust are now extremely strict about checking conditional compilation flags (cfg).
    When you use Anchor macros like #[program] and #[derive(Accounts)], Anchor injects a bunch of boilerplate code
    behind the scenes. Some of that boilerplate checks for internal Anchor features like "custom-heap",
    "custom-panic", and "anchor-debug". Because these features aren't explicitly declared in the project's
    Cargo.toml file, the new Rust compiler complains that it doesn't recognize them.
    To fix this, we need to declare these features in our Cargo.toml file, even though we won't be using them directly.
*/

#[program]
pub mod journal_dapp {
    use super::*;

    // Instruction to initialize the program state account. This will be called when the program is first deployed.
    // The first parameter is the context of the instruction, which contains the accounts that will be used in the instruction.
    pub fn create_journal_entry(ctx: Context<CreateJournalEntry>, title: String, content: String) -> Result<()> {
        let journal_entry_state = &mut ctx.accounts.journal_entry;
        journal_entry_state.owner = *ctx.accounts.owner.key;
        journal_entry_state.title = title;
        journal_entry_state.content = content;
        Ok(())
    }

    pub fn update_journal_entry(ctx: Context<UpdateJournalEntry>, content: String) -> Result<()> {
        let journal_entry_state = &mut ctx.accounts.journal_entry;
        // Check that the owner of the journal entry is the same as the signer of the transaction
        // We're completely eliminatinh this check and saving compute units by tweaking the seeds definition.
        // require!(journal_entry_state.owner == *ctx.accounts.owner.key, JournalError::Unauthorized);
        journal_entry_state.content = content;
        Ok(())
    }

    pub fn delete_journal_entry(_ctx: Context<DeleteJournalEntry>) -> Result<()> {
        // Anchor's seed validation guarantees the signer is the owner.
        Ok(())
    }
}

/*
This is the program state account. This is where all the data for the program will be stored.
This account will be owned by the program and will be used to store the state of the program.
*/
#[account]
#[derive(InitSpace)]
pub struct JournalEntryState {
    pub owner: Pubkey,
    #[max_len(50)]
    pub title: String,
    #[max_len(1000)]
    pub content: String
}

#[derive(Accounts)]
#[instruction(title: String, content: String)] // This pulls the instruction parameters from the instruction into the context, so we can use them in the account constraints here.
// When you are defining the context data structure for an instruction, you need to define all the accounts that will be passed through the instruction.
pub struct CreateJournalEntry<'info> {
    // The journal entry account
    #[account(
        init, // Because the account doesn't exist yet
        seeds = [title.as_bytes(), owner.key().as_ref()], // The seeds for the PDA
        bump, // Always goes with seeds
        payer = owner, // The account that will pay for the account creation
        space = 8 + JournalEntryState::INIT_SPACE
    )]
    pub journal_entry: Account<'info, JournalEntryState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>
}

#[derive(Accounts)]
pub struct UpdateJournalEntry<'info> {
    #[account(
        mut,
        /*
            Instead of using the owner stored inside the account data (journal_entry.owner) for the seed,
            we use the public key of the owner who is currently signing the transaction (owner.key()).
            Here is why this is powerful: If an attacker tries to pass someone else's journal entry,
            Anchor will try to derive the PDA using the attacker's public key. The derived address won't match
            the account provided, and Anchor will reject the transaction before the function even runs.
        */
        seeds = [journal_entry.title.as_bytes(), owner.key().as_ref()],
        bump,
        realloc = 8 + JournalEntryState::INIT_SPACE, // This is the new size of the account after the update. We need to specify this because we are changing the content of the journal entry, which can change the size of the account, so the rent exempt will differ.
        realloc::payer = owner, // The account that will pay for the account reallocation if needed
        realloc::zero = true // This will zero out the new space if the account is reallocated, which is important for security reasons, so we don't have any uninitialized data in the account.
    )] // This ensures that the journal entry account is mutable and that the owner of the journal entry is the same as the signer of the transaction
    pub journal_entry: Account<'info, JournalEntryState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>
}

#[derive(Accounts)]
pub struct DeleteJournalEntry<'info> {
    #[account(
        mut,
        close = owner, // This will close the account and send the remaining lamports to the owner account (It will only be closed if the owner of the journal entry is the same as the signer of the transaction, which is checked by the seeds constraint below)
        seeds = [journal_entry.title.as_bytes(), owner.key().as_ref()],
        bump
    )] // This ensures that the journal entry account is mutable and that the owner of the journal entry is the same as the signer of the transaction
    pub journal_entry: Account<'info, JournalEntryState>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>
}
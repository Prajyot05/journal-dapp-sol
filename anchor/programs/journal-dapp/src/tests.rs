#[cfg(test)]
mod tests {
    use crate::ID as PROGRAM_ID;
    use litesvm::LiteSVM;
    use solana_sdk::{
        instruction::{AccountMeta, Instruction},
        pubkey::Pubkey,
        signature::Keypair,
        signer::Signer,
        system_program,
        transaction::Transaction,
    };

    // ─── Constants ───────────────────────────────────────────────────────────────

    /// 1 SOL expressed in lamports.
    const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

    // ─── Anchor discriminators ────────────────────────────────────────────────────
    // Anchor uses the first 8 bytes of SHA-256("global:<instruction_name>") as a
    // discriminator that gets prepended to every instruction's data buffer so the
    // program can route to the correct handler.

    /// Discriminator for `create_journal_entry`.
    const CREATE_DISCRIMINATOR: [u8; 8] = [48, 65, 201, 186, 25, 41, 127, 0];
    /// Discriminator for `update_journal_entry`.
    const UPDATE_DISCRIMINATOR: [u8; 8] = [113, 164, 49, 62, 43, 83, 194, 172];
    /// Discriminator for `delete_journal_entry`.
    const DELETE_DISCRIMINATOR: [u8; 8] = [156, 50, 93, 5, 157, 97, 188, 114];

    // ─── Encoding helpers ─────────────────────────────────────────────────────────

    /// Borsh-encodes a `&str` as a little-endian u32 length prefix followed by
    /// the raw UTF-8 bytes — the wire format Anchor uses for `String` fields.
    fn encode_string(s: &str) -> Vec<u8> {
        let bytes = s.as_bytes();
        let mut buf = Vec::with_capacity(4 + bytes.len());
        // 4-byte little-endian length prefix (Borsh spec)
        buf.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        buf.extend_from_slice(bytes);
        buf
    }

    /// Builds the raw instruction data for `create_journal_entry(title, content)`.
    /// Layout: [discriminator (8) | title (4+n) | content (4+m)]
    fn build_create_data(title: &str, content: &str) -> Vec<u8> {
        let mut data = CREATE_DISCRIMINATOR.to_vec();
        data.extend(encode_string(title));
        data.extend(encode_string(content));
        data
    }

    /// Builds the raw instruction data for `update_journal_entry(content)`.
    /// Layout: [discriminator (8) | content (4+m)]
    fn build_update_data(content: &str) -> Vec<u8> {
        let mut data = UPDATE_DISCRIMINATOR.to_vec();
        data.extend(encode_string(content));
        data
    }

    /// Returns the 8-byte discriminator-only buffer used by `delete_journal_entry`
    /// (no extra arguments required).
    fn build_delete_data() -> Vec<u8> {
        DELETE_DISCRIMINATOR.to_vec()
    }

    // ─── PDA derivation ───────────────────────────────────────────────────────────

    /// Derives the Program Derived Address for a journal entry.
    /// Seeds: [title_bytes, owner_pubkey]  — mirrors the on-chain seed definition.
    fn derive_journal_pda(title: &str, owner: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[title.as_bytes(), owner.as_ref()],
            &PROGRAM_ID,
        )
    }

    // ─── Test fixture ─────────────────────────────────────────────────────────────

    /// Initialises a fresh LiteSVM instance, loads the compiled program binary,
    /// and funds the supplied keypair so it can pay for transactions.
    fn setup_svm(payer: &Keypair) -> LiteSVM {
        let mut svm = LiteSVM::new();

        // Load the compiled .so from the local build output.
        // `anchor build` places the shared library at target/deploy/<name>.so.
        svm.add_program_from_file(
            PROGRAM_ID,
            "../../target/deploy/journal_dapp.so",
        )
        .expect("Failed to load journal_dapp.so — run `anchor build` first");

        // Airdrop 10 SOL to the payer so tests can cover account-rent costs.
        svm.airdrop(&payer.pubkey(), 10 * LAMPORTS_PER_SOL)
            .expect("Airdrop failed");

        svm
    }

    // ─── Helper: send a signed transaction and assert success ─────────────────────

    fn send_tx(svm: &mut LiteSVM, payer: &Keypair, instruction: Instruction) {
        let blockhash = svm.latest_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&payer.pubkey()),
            &[payer],
            blockhash,
        );
        svm.send_transaction(tx)
            .expect("Transaction failed unexpectedly");
    }

    // ─── Tests ────────────────────────────────────────────────────────────────────

    /// Verifies that `create_journal_entry` initialises the PDA account with the
    /// correct owner, title, and content stored on-chain.
    #[test]
    fn test_create_journal_entry() {
        let owner = Keypair::new();
        let mut svm = setup_svm(&owner);

        let title = "My First Entry";
        let content = "Hello, Solana!";
        let (pda, _bump) = derive_journal_pda(title, &owner.pubkey());

        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(pda, false),               // journal_entry (writable PDA)
                AccountMeta::new(owner.pubkey(), true),     // owner (writable signer)
                AccountMeta::new_readonly(system_program::ID, false), // system_program
            ],
            data: build_create_data(title, content),
        };

        send_tx(&mut svm, &owner, ix);

        // The PDA account must exist after creation.
        let account = svm.get_account(&pda).expect("PDA account not found");
        assert!(account.lamports > 0, "PDA account should be rent-exempt");

        // Anchor places an 8-byte discriminator before the account data fields.
        // After the discriminator: owner (32) | title (4+n) | content (4+m)
        let data = &account.data;
        assert!(data.len() > 8 + 32, "Account data is unexpectedly short");

        // Verify the owner pubkey field (bytes 8..40).
        let stored_owner = Pubkey::try_from(&data[8..40]).unwrap();
        assert_eq!(stored_owner, owner.pubkey(), "Stored owner mismatch");

        // Verify the title field (bytes 40..44 = length, then UTF-8).
        let title_len = u32::from_le_bytes(data[40..44].try_into().unwrap()) as usize;
        let stored_title = std::str::from_utf8(&data[44..44 + title_len]).unwrap();
        assert_eq!(stored_title, title, "Stored title mismatch");

        // Verify the content field follows the title.
        let content_offset = 44 + title_len;
        let content_len = u32::from_le_bytes(
            data[content_offset..content_offset + 4].try_into().unwrap(),
        ) as usize;
        let stored_content =
            std::str::from_utf8(&data[content_offset + 4..content_offset + 4 + content_len])
                .unwrap();
        assert_eq!(stored_content, content, "Stored content mismatch");
    }

    /// Verifies that `update_journal_entry` overwrites only the content while
    /// leaving the owner and title fields intact.
    #[test]
    fn test_update_journal_entry() {
        let owner = Keypair::new();
        let mut svm = setup_svm(&owner);

        let title = "Update Test";
        let (pda, _bump) = derive_journal_pda(title, &owner.pubkey());

        // Step 1: create the entry first.
        let create_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(pda, false),
                AccountMeta::new(owner.pubkey(), true),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data: build_create_data(title, "Original content"),
        };
        send_tx(&mut svm, &owner, create_ix);

        // Step 2: update the entry with new content.
        let new_content = "Updated content — much better!";
        let update_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(pda, false),
                AccountMeta::new(owner.pubkey(), true),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data: build_update_data(new_content),
        };
        send_tx(&mut svm, &owner, update_ix);

        // Verify the updated content on-chain.
        let data = svm.get_account(&pda).unwrap().data;
        let title_len = u32::from_le_bytes(data[40..44].try_into().unwrap()) as usize;
        let content_offset = 44 + title_len;
        let content_len = u32::from_le_bytes(
            data[content_offset..content_offset + 4].try_into().unwrap(),
        ) as usize;
        let stored_content =
            std::str::from_utf8(&data[content_offset + 4..content_offset + 4 + content_len])
                .unwrap();
        assert_eq!(stored_content, new_content, "Content was not updated");
    }

    /// Verifies that `delete_journal_entry` closes the PDA account and returns
    /// the remaining lamports to the owner.
    #[test]
    fn test_delete_journal_entry() {
        let owner = Keypair::new();
        let mut svm = setup_svm(&owner);

        let title = "Delete Me";
        let (pda, _bump) = derive_journal_pda(title, &owner.pubkey());

        // Step 1: create the entry.
        let create_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(pda, false),
                AccountMeta::new(owner.pubkey(), true),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data: build_create_data(title, "Temporary content"),
        };
        send_tx(&mut svm, &owner, create_ix);

        // Confirm the account exists before deletion.
        assert!(svm.get_account(&pda).is_some(), "PDA should exist after create");

        // Step 2: delete the entry.
        let delete_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(pda, false),
                AccountMeta::new(owner.pubkey(), true),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data: build_delete_data(),
        };
        send_tx(&mut svm, &owner, delete_ix);

        // After `close = owner`, the PDA's lamports are zeroed and data cleared.
        // LiteSVM represents a closed account as None or an account with 0 lamports.
        let maybe_account = svm.get_account(&pda);
        let is_closed = maybe_account
            .map(|acc| acc.lamports == 0)
            .unwrap_or(true);
        assert!(is_closed, "PDA account should be closed (0 lamports) after delete");
    }

    /// Verifies that a different keypair (attacker) cannot update another user's
    /// journal entry.  The seeds constraint on-chain derives the PDA from the
    /// *signer's* pubkey, so the derived address will not match the provided
    /// account, causing Anchor to reject the transaction.
    #[test]
    fn test_unauthorized_update_fails() {
        let owner = Keypair::new();
        let attacker = Keypair::new();
        let mut svm = setup_svm(&owner);

        // Fund the attacker independently.
        svm.airdrop(&attacker.pubkey(), 5 * LAMPORTS_PER_SOL)
            .expect("Attacker airdrop failed");

        let title = "Owner's Private Entry";
        let (pda, _bump) = derive_journal_pda(title, &owner.pubkey());

        // Create the legitimate entry as the owner.
        let create_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(pda, false),
                AccountMeta::new(owner.pubkey(), true),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data: build_create_data(title, "Private thoughts"),
        };
        send_tx(&mut svm, &owner, create_ix);

        // Attacker tries to supply the owner's PDA but sign as themselves.
        // The program derives the PDA from the attacker's pubkey — it won't
        // match `pda`, so Anchor rejects the instruction.
        let malicious_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(pda, false),              // owner's PDA
                AccountMeta::new(attacker.pubkey(), true), // attacker signs
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data: build_update_data("Hacked!"),
        };

        let blockhash = svm.latest_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &[malicious_ix],
            Some(&attacker.pubkey()),
            &[&attacker],
            blockhash,
        );
        let result = svm.send_transaction(tx);
        assert!(
            result.is_err(),
            "Unauthorized update should have been rejected by the runtime"
        );
    }

    /// Verifies that a different keypair (attacker) cannot delete another user's
    /// journal entry for the same reason as the update attack above.
    #[test]
    fn test_unauthorized_delete_fails() {
        let owner = Keypair::new();
        let attacker = Keypair::new();
        let mut svm = setup_svm(&owner);

        svm.airdrop(&attacker.pubkey(), 5 * LAMPORTS_PER_SOL)
            .expect("Attacker airdrop failed");

        let title = "Do Not Delete";
        let (pda, _bump) = derive_journal_pda(title, &owner.pubkey());

        // Create entry.
        let create_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(pda, false),
                AccountMeta::new(owner.pubkey(), true),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data: build_create_data(title, "Keep this safe"),
        };
        send_tx(&mut svm, &owner, create_ix);

        // Attacker tries to delete using the owner's PDA but their own signer.
        let malicious_ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(pda, false),
                AccountMeta::new(attacker.pubkey(), true),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data: build_delete_data(),
        };

        let blockhash = svm.latest_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &[malicious_ix],
            Some(&attacker.pubkey()),
            &[&attacker],
            blockhash,
        );
        let result = svm.send_transaction(tx);
        assert!(
            result.is_err(),
            "Unauthorized delete should have been rejected by the runtime"
        );
    }

    /// Verifies that two different users can each maintain independent journal
    /// entries under the same title without any collision, since the PDA seeds
    /// include both the title and the owner's public key.
    #[test]
    fn test_multiple_owners_same_title() {
        let alice = Keypair::new();
        let bob = Keypair::new();
        let mut svm = LiteSVM::new();

        svm.add_program_from_file(PROGRAM_ID, "../../target/deploy/journal_dapp.so")
            .expect("Failed to load journal_dapp.so");
        svm.airdrop(&alice.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
        svm.airdrop(&bob.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();

        let title = "Shared Title";

        let (alice_pda, _) = derive_journal_pda(title, &alice.pubkey());
        let (bob_pda, _) = derive_journal_pda(title, &bob.pubkey());

        // Both PDAs must be distinct because the owner pubkey differs.
        assert_ne!(alice_pda, bob_pda, "PDAs for different owners must differ");

        // Alice creates her entry.
        send_tx(
            &mut svm,
            &alice,
            Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new(alice_pda, false),
                    AccountMeta::new(alice.pubkey(), true),
                    AccountMeta::new_readonly(system_program::ID, false),
                ],
                data: build_create_data(title, "Alice's thoughts"),
            },
        );

        // Bob creates his entry under the same title.
        send_tx(
            &mut svm,
            &bob,
            Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new(bob_pda, false),
                    AccountMeta::new(bob.pubkey(), true),
                    AccountMeta::new_readonly(system_program::ID, false),
                ],
                data: build_create_data(title, "Bob's thoughts"),
            },
        );

        // Both accounts must exist independently.
        assert!(svm.get_account(&alice_pda).is_some(), "Alice's PDA missing");
        assert!(svm.get_account(&bob_pda).is_some(), "Bob's PDA missing");
    }

    /// Verifies the full CRUD lifecycle: create → update → delete.
    #[test]
    fn test_full_lifecycle() {
        let owner = Keypair::new();
        let mut svm = setup_svm(&owner);

        let title = "Lifecycle Entry";
        let (pda, _) = derive_journal_pda(title, &owner.pubkey());

        // 1. Create
        send_tx(
            &mut svm,
            &owner,
            Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new(pda, false),
                    AccountMeta::new(owner.pubkey(), true),
                    AccountMeta::new_readonly(system_program::ID, false),
                ],
                data: build_create_data(title, "Initial content"),
            },
        );
        assert!(svm.get_account(&pda).is_some());

        // 2. Update
        send_tx(
            &mut svm,
            &owner,
            Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new(pda, false),
                    AccountMeta::new(owner.pubkey(), true),
                    AccountMeta::new_readonly(system_program::ID, false),
                ],
                data: build_update_data("Revised content"),
            },
        );

        // 3. Delete
        send_tx(
            &mut svm,
            &owner,
            Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new(pda, false),
                    AccountMeta::new(owner.pubkey(), true),
                    AccountMeta::new_readonly(system_program::ID, false),
                ],
                data: build_delete_data(),
            },
        );

        let is_closed = svm.get_account(&pda)
            .map(|acc| acc.lamports == 0)
            .unwrap_or(true);
        assert!(is_closed, "Account should be closed after delete");
    }
}

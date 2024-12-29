import * as anchor from "@coral-xyz/anchor";
import { AnchorEscrow } from "../target/types/anchor_escrow";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { randomBytes } from "crypto";
import { assert } from "chai";

describe("anchor-escrow", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider();
  const connection = provider.connection;
  const program = anchor.workspace.AnchorEscrow as anchor.Program<AnchorEscrow>;

  const initializer = Keypair.generate();
  const taker = Keypair.generate();
  const mintA = Keypair.generate();
  const mintB = Keypair.generate();

  const initializerAtaA = getAssociatedTokenAddressSync(mintA.publicKey, initializer.publicKey);
  const initializerAtaB = getAssociatedTokenAddressSync(mintB.publicKey, initializer.publicKey);
  const takerAtaA = getAssociatedTokenAddressSync(mintA.publicKey, taker.publicKey);
  const takerAtaB = getAssociatedTokenAddressSync(mintB.publicKey, taker.publicKey);

  const seed = new anchor.BN(randomBytes(8));
  const escrow = PublicKey.findProgramAddressSync(
    [Buffer.from("state"), seed.toArrayLike(Buffer, "le", 8)],
    program.programId
  )[0];
  const vaultA = getAssociatedTokenAddressSync(mintA.publicKey, escrow, true);
  const vaultB = getAssociatedTokenAddressSync(mintB.publicKey, escrow, true);

  const confirm = async (signature: string): Promise<string> => {
    const block = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature,
      ...block,
    });
    return signature;
  };

  const log = async (signature: string): Promise<string> => {
    console.log(
      `Your transaction signature: https://explorer.solana.com/transaction/${signature}?cluster=devnet`
    );
    return signature;
  };

  it("Airdrop and create mints", async () => {
    let lamports = await getMinimumBalanceForRentExemptMint(connection);
    let tx = new anchor.web3.Transaction();

    tx.add(
      SystemProgram.transfer({
        fromPubkey: provider.publicKey,
        toPubkey: initializer.publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL,
      }),
      SystemProgram.transfer({
        fromPubkey: provider.publicKey,
        toPubkey: taker.publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL,
      })
    );

    tx.add(
      SystemProgram.createAccount({
        fromPubkey: provider.publicKey,
        newAccountPubkey: mintA.publicKey,
        lamports,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mintA.publicKey, 6, initializer.publicKey, null),
      createAssociatedTokenAccountIdempotentInstruction(
        provider.publicKey,
        initializerAtaA,
        initializer.publicKey,
        mintA.publicKey
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        provider.publicKey,
        takerAtaA,
        taker.publicKey,
        mintA.publicKey
      ),
      createMintToInstruction(mintA.publicKey, initializerAtaA, initializer.publicKey, 1e9)
    );

    tx.add(
      SystemProgram.createAccount({
        fromPubkey: provider.publicKey,
        newAccountPubkey: mintB.publicKey,
        lamports,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mintB.publicKey, 6, taker.publicKey, null),
      createAssociatedTokenAccountIdempotentInstruction(
        provider.publicKey,
        initializerAtaB,
        initializer.publicKey,
        mintB.publicKey
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        provider.publicKey,
        takerAtaB,
        taker.publicKey,
        mintB.publicKey
      ),
      createMintToInstruction(mintB.publicKey, takerAtaB, taker.publicKey, 1e9)
    );

    await provider.sendAndConfirm(tx, [mintA, mintB, initializer, taker]).then(log);
  });

  it("Initialize escrow", async () => {
    const initializerAmount = 1e6;
    const takerAmount = 1e6;

    try {
      const tx = await program.methods
        .initialize(seed, new anchor.BN(initializerAmount), new anchor.BN(takerAmount), taker.publicKey)
        .accounts({
          initializer: initializer.publicKey,
          mintA: mintA.publicKey,
          mintB: mintB.publicKey,
          initializerAtaA,
          escrow,
          vaultA,
          vaultB,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([initializer])
        .rpc();

      await confirm(tx);
      await log(tx);
    } catch (error: any) {
      console.error("Detailed error:", error);
      if (error.logs) console.error("Program logs:", error.logs);
      throw error;
    }
  });

  it("Taker deposits tokens to vault", async () => {
    const takerAmount = 1e6;
    const tx = new anchor.web3.Transaction().add(
      createTransferCheckedInstruction(
        takerAtaB,
        mintB.publicKey,
        vaultB,
        taker.publicKey,
        takerAmount,
        6
      )
    );

    await provider.sendAndConfirm(tx, [taker]).then(log);
  });

  it("Exchange", async () => {
    try {
      const initializerAtaABefore = await connection.getTokenAccountBalance(initializerAtaA);
      const initializerAtaBBefore = await connection.getTokenAccountBalance(initializerAtaB);
      const takerAtaABefore = await connection.getTokenAccountBalance(takerAtaA);
      const takerAtaBBefore = await connection.getTokenAccountBalance(takerAtaB);
      const vaultABefore = await connection.getTokenAccountBalance(vaultA);
      const vaultBBefore = await connection.getTokenAccountBalance(vaultB);

      console.log("=== Balances Before Exchange ===");
      console.log(`Initializer Token A: ${initializerAtaABefore.value.uiAmount}`);
      console.log(`Initializer Token B: ${initializerAtaBBefore.value.uiAmount}`);
      console.log(`Taker Token A: ${takerAtaABefore.value.uiAmount}`);
      console.log(`Taker Token B: ${takerAtaBBefore.value.uiAmount}`);
      console.log(`Vault Token A: ${vaultABefore.value.uiAmount}`);
      console.log(`Vault Token B: ${vaultBBefore.value.uiAmount}`);

      console.log("\n=== Wallet Addresses ===");
      console.log(`Initializer: ${initializer.publicKey.toString()}`);
      console.log(`Taker: ${taker.publicKey.toString()}`);

      const tx = await program.methods
        .exchange()
        .accounts({
          initializer: initializer.publicKey,
          taker: taker.publicKey,
          mintA: mintA.publicKey,
          mintB: mintB.publicKey,
          initializerAtaA,
          initializerAtaB,
          escrow,
          vaultA,
          vaultB,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([initializer])
        .transaction();

      const txHash = await provider.sendAndConfirm(tx, [initializer]);
      console.log("Transaction signature:", txHash);

      const initializerAtaAAfter = await connection.getTokenAccountBalance(initializerAtaA);
      const initializerAtaBAfter = await connection.getTokenAccountBalance(initializerAtaB);
      const takerAtaAAfter = await connection.getTokenAccountBalance(takerAtaA);
      const takerAtaBAfter = await connection.getTokenAccountBalance(takerAtaB);

      console.log("\n=== Balances After Exchange ===");
      console.log(`Initializer Token A: ${initializerAtaAAfter.value.uiAmount}`);
      console.log(`Initializer Token B: ${initializerAtaBAfter.value.uiAmount}`);
      console.log(`Taker Token A: ${takerAtaAAfter.value.uiAmount}`);
      console.log(`Taker Token B: ${takerAtaBAfter.value.uiAmount}`);

      assert.approximately(
        initializerAtaBAfter.value.uiAmount!, 
        vaultBBefore.value.uiAmount!, 
        0.000001, 
        "Initializer should receive Token B from vault"
      );
      assert.approximately(
        takerAtaAAfter.value.uiAmount!, 
        vaultABefore.value.uiAmount!, 
        0.000001, 
        "Taker should receive Token A from vault"
      );

    } catch (error: any) {
      console.error("Detailed error:", error);
      if (error.logs) console.error("Program logs:", error.logs);
      throw error;
    }
  });

  /*
  it("Exchange succeeds with third-party donator", async () => {
    try {
      const initializerAmount = 1e6;
      const takerAmount = 1e6;
      const newSeed = new anchor.BN(randomBytes(8));
      
      const newEscrow = PublicKey.findProgramAddressSync(
        [Buffer.from("state"), newSeed.toArrayLike(Buffer, "le", 8)],
        program.programId
      )[0];
      const newVaultA = getAssociatedTokenAddressSync(mintA.publicKey, newEscrow, true);
      const newVaultB = getAssociatedTokenAddressSync(mintB.publicKey, newEscrow, true);

      await program.methods
        .initialize(newSeed, new anchor.BN(initializerAmount), new anchor.BN(takerAmount), taker.publicKey)
        .accounts({
          initializer: initializer.publicKey,
          mintA: mintA.publicKey,
          mintB: mintB.publicKey,
          initializerAtaA,
          escrow: newEscrow,
          vaultA: newVaultA,
          vaultB: newVaultB,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([initializer])
        .rpc();

      const donator = Keypair.generate();
      const donatorAtaB = getAssociatedTokenAddressSync(mintB.publicKey, donator.publicKey);

      const fundTx = new anchor.web3.Transaction();
      fundTx.add(
        SystemProgram.transfer({
          fromPubkey: provider.publicKey,
          toPubkey: donator.publicKey,
          lamports: 0.1 * LAMPORTS_PER_SOL,
        }),
        createAssociatedTokenAccountIdempotentInstruction(
          provider.publicKey,
          donatorAtaB,
          donator.publicKey,
          mintB.publicKey
        ),
      );
      await provider.sendAndConfirm(fundTx);

      await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          createMintToInstruction(
            mintB.publicKey,
            donatorAtaB,
            taker.publicKey,
            takerAmount
          )
        ),
        [taker]
      );

      const initializerAtaABefore = await connection.getTokenAccountBalance(initializerAtaA);
      const takerAtaABefore = await connection.getTokenAccountBalance(takerAtaA);
      const takerAtaBBefore = await connection.getTokenAccountBalance(takerAtaB);
      const donatorAtaBBefore = await connection.getTokenAccountBalance(donatorAtaB);
      const vaultABefore = await connection.getTokenAccountBalance(newVaultA);

      console.log("\n=== Balances Before Donator Deposit ===");
      console.log(`Initializer Token A: ${initializerAtaABefore.value.uiAmount}`);
      console.log(`Taker Token A: ${takerAtaABefore.value.uiAmount}`);
      console.log(`Taker Token B: ${takerAtaBBefore.value.uiAmount}`);
      console.log(`Donator Token B: ${donatorAtaBBefore.value.uiAmount}`);
      console.log(`Vault Token A: ${vaultABefore.value.uiAmount}`);

      await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          createTransferCheckedInstruction(
            donatorAtaB,
            mintB.publicKey,
            newVaultB,
            donator.publicKey,
            takerAmount,
            6
          )
        ),
        [donator]
      ).then(log);

      await program.methods
        .exchange()
        .accounts({
          initializer: initializer.publicKey,
          taker: taker.publicKey,
          mintA: mintA.publicKey,
          mintB: mintB.publicKey,
          initializerAtaA,
          initializerAtaB,
          takerAtaA,
          takerAtaB,
          escrow: newEscrow,
          vaultA: newVaultA,
          vaultB: newVaultB,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([initializer])
        .rpc()
        .then(confirm)
        .then(log);

      const initializerAtaAAfter = await connection.getTokenAccountBalance(initializerAtaA);
      const initializerAtaBAfter = await connection.getTokenAccountBalance(initializerAtaB);
      const takerAtaAAfter = await connection.getTokenAccountBalance(takerAtaA);
      const takerAtaBAfter = await connection.getTokenAccountBalance(takerAtaB);
      const donatorAtaBAfter = await connection.getTokenAccountBalance(donatorAtaB);

      console.log("\n=== Balances After Exchange with Donator ===");
      console.log(`Initializer Token A: ${initializerAtaAAfter.value.uiAmount}`);
      console.log(`Initializer Token B: ${initializerAtaBAfter.value.uiAmount}`);
      console.log(`Taker Token A: ${takerAtaAAfter.value.uiAmount}`);
      console.log(`Taker Token B: ${takerAtaBAfter.value.uiAmount}`);
      console.log(`Donator Token B: ${donatorAtaBAfter.value.uiAmount}`);

      assert.approximately(
        initializerAtaBAfter.value.uiAmount!,
        takerAmount / 1e6,
        0.000001,
        "Initializer should receive the full amount of Token B"
      );

      assert.approximately(
        takerAtaAAfter.value.uiAmount!,
        vaultABefore.value.uiAmount!,
        0.000001,
        "Taker should receive Token A even though donator provided Token B"
      );

      assert.approximately(
        donatorAtaBAfter.value.uiAmount!,
        0,
        0.000001,
        "Donator should have spent their tokens"
      );

    } catch (error: any) {
      console.error("Detailed error:", error);
      if (error.logs) console.error("Program logs:", error.logs);
      throw error;
    }
  });
  */

  /*
  it("Exchange succeeds with 95% of requested amount", async () => {
    try {
      const takerAmount = 1e6;
      const amount95Percent = Math.floor(takerAmount * 0.95);

      const depositTx = new anchor.web3.Transaction().add(
        createTransferCheckedInstruction(
          takerAtaB,
          mintB.publicKey,
          vaultB,
          taker.publicKey,
          amount95Percent,
          6
        )
      );
      await provider.sendAndConfirm(depositTx, [taker]).then(log);

      const initializerAtaABefore = await connection.getTokenAccountBalance(initializerAtaA);
      const initializerAtaBBefore = await connection.getTokenAccountBalance(initializerAtaB);
      const takerAtaABefore = await connection.getTokenAccountBalance(takerAtaA);
      const takerAtaBBefore = await connection.getTokenAccountBalance(takerAtaB);
      const vaultABefore = await connection.getTokenAccountBalance(vaultA);
      const vaultBBefore = await connection.getTokenAccountBalance(vaultB);

      console.log("\n=== Balances Before 95% Exchange ===");
      console.log(`Initializer Token A: ${initializerAtaABefore.value.uiAmount}`);
      console.log(`Initializer Token B: ${initializerAtaBBefore.value.uiAmount}`);
      console.log(`Taker Token A: ${takerAtaABefore.value.uiAmount}`);
      console.log(`Taker Token B: ${takerAtaBBefore.value.uiAmount}`);
      console.log(`Vault Token A: ${vaultABefore.value.uiAmount}`);
      console.log(`Vault Token B: ${vaultBBefore.value.uiAmount}`);

      const tx = await program.methods
        .exchange()
        .accounts({
          initializer: initializer.publicKey,
          taker: taker.publicKey,
          mintA: mintA.publicKey,
          mintB: mintB.publicKey,
          initializerAtaA,
          initializerAtaB,
          takerAtaA,
          takerAtaB,
          escrow,
          vaultA,
          vaultB,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([initializer])
        .rpc();

      await confirm(tx);
      await log(tx);

      const initializerAtaAAfter = await connection.getTokenAccountBalance(initializerAtaA);
      const initializerAtaBAfter = await connection.getTokenAccountBalance(initializerAtaB);
      const takerAtaAAfter = await connection.getTokenAccountBalance(takerAtaA);
      const takerAtaBAfter = await connection.getTokenAccountBalance(takerAtaB);

      console.log("\n=== Balances After 95% Exchange ===");
      console.log(`Initializer Token A: ${initializerAtaAAfter.value.uiAmount}`);
      console.log(`Initializer Token B: ${initializerAtaBAfter.value.uiAmount}`);
      console.log(`Taker Token A: ${takerAtaAAfter.value.uiAmount}`);
      console.log(`Taker Token B: ${takerAtaBAfter.value.uiAmount}`);

      assert.approximately(
        initializerAtaBAfter.value.uiAmount!,
        amount95Percent / 1e6, // Convert to UI amount
        0.000001,
        "Initializer should receive 95% of requested Token B"
      );

      assert.approximately(
        takerAtaAAfter.value.uiAmount!,
        vaultABefore.value.uiAmount!,
        0.000001,
        "Taker should receive the full amount of Token A"
      );

    } catch (error: any) {
      console.error("Detailed error:", error);
      if (error.logs) console.error("Program logs:", error.logs);
      throw error;
    }
  });
  */

  /*
  it("Exchange fails with 90% of requested amount", async () => {
    try {
      const initializerAmount = 1e6;
      const takerAmount = 1e6;
      const newSeed = new anchor.BN(randomBytes(8));
      
      const newEscrow = PublicKey.findProgramAddressSync(
        [Buffer.from("state"), newSeed.toArrayLike(Buffer, "le", 8)],
        program.programId
      )[0];
      const newVaultA = getAssociatedTokenAddressSync(mintA.publicKey, newEscrow, true);
      const newVaultB = getAssociatedTokenAddressSync(mintB.publicKey, newEscrow, true);

      await program.methods
        .initialize(newSeed, new anchor.BN(initializerAmount), new anchor.BN(takerAmount), taker.publicKey)
        .accounts({
          initializer: initializer.publicKey,
          mintA: mintA.publicKey,
          mintB: mintB.publicKey,
          initializerAtaA,
          escrow: newEscrow,
          vaultA: newVaultA,
          vaultB: newVaultB,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([initializer])
        .rpc();

      const amount90Percent = Math.floor(takerAmount * 0.9);
      const depositTx = new anchor.web3.Transaction().add(
        createTransferCheckedInstruction(
          takerAtaB,
          mintB.publicKey,
          newVaultB,
          taker.publicKey,
          amount90Percent,
          6
        )
      );
      await provider.sendAndConfirm(depositTx, [taker]);

      try {
        await program.methods
          .exchange()
          .accounts({
            initializer: initializer.publicKey,
            taker: taker.publicKey,
            mintA: mintA.publicKey,
            mintB: mintB.publicKey,
            initializerAtaA,
            initializerAtaB,
            takerAtaA,
            takerAtaB,
            escrow: newEscrow,
            vaultA: newVaultA,
            vaultB: newVaultB,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([initializer])
          .rpc();
        
        assert.fail("Exchange should have failed with 90% of requested amount");
      } catch (error: any) {
        console.log(error);
        assert.include(
          error.message, 
          "InsufficientTakerTokens",
          "Expected InsufficientTakerTokens error"
        );
      }

    } catch (error: any) {
      if (error.logs) console.error("Program logs:", error.logs);
      throw error;
    }
  });
  */

  /*
  it("Cancel escrow - by initializer", async () => {
    try {
      const initializerAtaABefore = await connection.getTokenAccountBalance(initializerAtaA);
      const takerAtaBBefore = await connection.getTokenAccountBalance(takerAtaB);
      const vaultABefore = await connection.getTokenAccountBalance(vaultA);
      const vaultBBefore = await connection.getTokenAccountBalance(vaultB);

      console.log("\n=== Balances Before Cancel (Initializer) ===");
      console.log(`Initializer Token A: ${initializerAtaABefore.value.uiAmount}`);
      console.log(`Taker Token B: ${takerAtaBBefore.value.uiAmount}`);
      console.log(`Vault Token A: ${vaultABefore.value.uiAmount}`);
      console.log(`Vault Token B: ${vaultBBefore.value.uiAmount}`);

      const tx = await program.methods
        .cancel()
        .accounts({
          signer: initializer.publicKey,
          initializer: initializer.publicKey,
          taker: taker.publicKey,
          mintA: mintA.publicKey,
          mintB: mintB.publicKey,
          initializerAtaA: initializerAtaA,
          takerAtaB,
          escrow,
          vaultA,
          vaultB,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([initializer])
        .rpc();

      await confirm(tx);
      await log(tx);

      const initializerAtaAAfter = await connection.getTokenAccountBalance(initializerAtaA);
      const takerAtaBAfter = await connection.getTokenAccountBalance(takerAtaB);

      console.log("\n=== Balances After Cancel (Initializer) ===");
      console.log(`Initializer Token A: ${initializerAtaAAfter.value.uiAmount}`);
      console.log(`Taker Token B: ${takerAtaBAfter.value.uiAmount}`);

      assert.approximately(
        initializerAtaAAfter.value.uiAmount!,
        initializerAtaABefore.value.uiAmount! + vaultABefore.value.uiAmount!,
        0.000001,
        "Initializer should receive their Token A back from vault"
      );

      assert.approximately(
        takerAtaBAfter.value.uiAmount!,
        takerAtaBBefore.value.uiAmount! + vaultBBefore.value.uiAmount!,
        0.000001,
        "Taker should receive their Token B back from vault"
      );

      // Verify accounts are closed
      const vaultAAccount = await connection.getAccountInfo(vaultA);
      const vaultBAccount = await connection.getAccountInfo(vaultB);
      const escrowAccount = await connection.getAccountInfo(escrow);
      assert.isNull(vaultAAccount, "Vault A should be closed");
      assert.isNull(vaultBAccount, "Vault B should be closed");
      assert.isNull(escrowAccount, "Escrow should be closed");

    } catch (error: any) {
      console.error("Detailed error:", error);
      if (error.logs) console.error("Program logs:", error.logs);
      throw error;
    }
  });
  */
  
  /*
  it("Cancel escrow - by taker", async () => {
    // First create and fund a new escrow
    const newSeed = new anchor.BN(randomBytes(8));
    const newEscrow = PublicKey.findProgramAddressSync(
      [Buffer.from("state"), newSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
    const newVaultA = getAssociatedTokenAddressSync(mintA.publicKey, newEscrow, true);
    const newVaultB = getAssociatedTokenAddressSync(mintB.publicKey, newEscrow, true);

    // Initialize new escrow
    await program.methods
      .initialize(newSeed, new anchor.BN(1e6), new anchor.BN(1e6), taker.publicKey)
      .accounts({
        signer: taker.publicKey,
        initializer: initializer.publicKey,
        taker: taker.publicKey,
        mintA: mintA.publicKey,
        mintB: mintB.publicKey,
        initializerAtaA: initializerAtaA,
        escrow: newEscrow,
        vaultA: newVaultA,
        vaultB: newVaultB,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([initializer])
      .rpc();

    // Fund vault B
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        createTransferCheckedInstruction(
          takerAtaB,
          mintB.publicKey,
          newVaultB,
          taker.publicKey,
          1e6,
          6
        )
      ),
      [taker]
    );

    try {
      const initializerAtaABefore = await connection.getTokenAccountBalance(initializerAtaA);
      const takerAtaBBefore = await connection.getTokenAccountBalance(takerAtaB);
      const vaultABefore = await connection.getTokenAccountBalance(newVaultA);
      const vaultBBefore = await connection.getTokenAccountBalance(newVaultB);

      console.log("\n=== Balances Before Cancel (Taker) ===");
      console.log(`Initializer Token A: ${initializerAtaABefore.value.uiAmount}`);
      console.log(`Taker Token B: ${takerAtaBBefore.value.uiAmount}`);
      console.log(`Vault Token A: ${vaultABefore.value.uiAmount}`);
      console.log(`Vault Token B: ${vaultBBefore.value.uiAmount}`);

      const tx = await program.methods
        .cancel()
        .accounts({
          signer: taker.publicKey,
          initializer: initializer.publicKey,
          taker: taker.publicKey,
          mintA: mintA.publicKey,
          mintB: mintB.publicKey,
          initializerAtaA: initializerAtaA,
          takerAtaB,
          escrow: newEscrow,
          vaultA: newVaultA,
          vaultB: newVaultB,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([taker])
        .rpc();

      await confirm(tx);
      await log(tx);

      const initializerAtaAAfter = await connection.getTokenAccountBalance(initializerAtaA);
      const takerAtaBAfter = await connection.getTokenAccountBalance(takerAtaB);

      console.log("\n=== Balances After Cancel (Taker) ===");
      console.log(`Initializer Token A: ${initializerAtaAAfter.value.uiAmount}`);
      console.log(`Taker Token B: ${takerAtaBAfter.value.uiAmount}`);

      assert.approximately(
        initializerAtaAAfter.value.uiAmount!,
        initializerAtaABefore.value.uiAmount! + vaultABefore.value.uiAmount!,
        0.000001,
        "Initializer should receive their Token A back from vault"
      );

      assert.approximately(
        takerAtaBAfter.value.uiAmount!,
        takerAtaBBefore.value.uiAmount! + vaultBBefore.value.uiAmount!,
        0.000001,
        "Taker should receive their Token B back from vault"
      );

      // Verify accounts are closed
      const vaultAAccount = await connection.getAccountInfo(newVaultA);
      const vaultBAccount = await connection.getAccountInfo(newVaultB);
      const escrowAccount = await connection.getAccountInfo(newEscrow);
      assert.isNull(vaultAAccount, "Vault A should be closed");
      assert.isNull(vaultBAccount, "Vault B should be closed");
      assert.isNull(escrowAccount, "Escrow should be closed");

    } catch (error: any) {
      console.error("Detailed error:", error);
      if (error.logs) console.error("Program logs:", error.logs);
      throw error;
    }
  });
  */

  /*
  it("Cancel escrow - should fail with unauthorized account", async () => {
    const unauthorized = Keypair.generate();
    
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.publicKey,
          toPubkey: unauthorized.publicKey,
          lamports: 0.1 * LAMPORTS_PER_SOL,
        })
      )
    );

    try {
      const tx = await program.methods
        .cancel()
        .accounts({
          signer: unauthorized.publicKey,
          initializer: initializer.publicKey,
          taker: taker.publicKey,
          mintA: mintA.publicKey,
          mintB: mintB.publicKey,
          initializerAtaA,
          takerAtaB,
          escrow,
          vaultA,
          vaultB,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([unauthorized])
        .rpc();

      assert.fail("Expected transaction to fail");
    } catch (error: any) {
      console.log("Full error:", error);
      if (error.logs) console.log("Program logs:", error.logs);
      
      assert.equal(error.error.errorCode.code, "ConstraintRaw");
      assert.ok(error.error.errorCode.number === 2003);
    }
  });
  */
});

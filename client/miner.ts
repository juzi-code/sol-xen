import dotenv from 'dotenv';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';
import { getAddress } from 'viem';
import {debug} from 'debug';
import {ComputeBudgetProgram, LAMPORTS_PER_SOL} from '@solana/web3.js';
import {AnchorProvider, setProvider, Program, web3, Wallet, workspace, utils} from '@coral-xyz/anchor';
import * as fs from "node:fs";
import path from "node:path";
import {getMint, TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {SolXen} from '../target/types/sol_xen';

dotenv.config();
debug.enable(process.env.DEBUG || '*')

enum Cmd {
    Mine = 'mine',
    Balance = 'balance',
}

const G = '\x1b[32m';
const Y = '\x1b[33m';

function numToUint8Array(num: number, count: number = 4) {
    const arr = new Uint8Array(count);
    for (let i = 0; i < count; i++)
        arr.set([num / 0x100 ** i], count - 1 - i)
    return arr;
}

async function main() {
    const log = debug("sol-xen")
    const error = debug("sol-xen:error")
    const [, , , ...params] = process.argv;

    let cmd: Cmd;
    let address: string;
    let priorityFee: number;
    let units: number;
    let runs: number;

    const yArgs = yargs(hideBin(process.argv))
        .command(Cmd.Mine, 'Checks gas-related params returned by current network')
        .command(Cmd.Balance, 'Checks balance of a master account')
        .option('priorityFee', {
            alias: 'f',
            type: 'number',
            default: 1,
            description: 'Solana priority fee, micro-lamports'
        })
        .option('units', {
            alias: 'u',
            type: 'number',
            default: 1_400_000,
            description: 'Solana MAX Compute Units'
        })
        .option('address', {
            alias: 'addr',
            type: 'string',
            description: 'Ethereum address to relate XN points to'
        })
        .option('runs', {
            alias: 'r',
            type: 'number',
            default: 1,
            description: 'Number of runs'
        })
        .help()

    cmd = yArgs.argv._[0];

    if (!cmd && params.length === 0) {
        yArgs.help();
        process.exit(1)
    }

    if (yArgs.argv.priorityFee) {
        priorityFee = parseInt(yArgs.argv.priorityFee)
    }

    if (yArgs.argv.units) {
        units = parseInt(yArgs.argv.units)
    }

    if (yArgs.argv.runs) {
        runs = parseInt(yArgs.argv.runs)
    }

    if (yArgs.argv.address) {
        try {
            address = getAddress(yArgs.argv.address)
        } catch (e) {
            error(e.message);
            process.exit(1)
        }
    }

    const network = process.env.ANCHOR_PROVIDER_URL || 'localnet';
    log(`${G}Running on ${network}`)
    const connection = new web3.Connection(network, 'processed');

    // Load user wallet keypair
    let user: web3.Keypair;
    if (process.env.USER_WALLET) {
        const userKeyPairFileName = process.env.USER_WALLET;
        const userKeyPairString = fs.readFileSync(path.resolve(userKeyPairFileName), 'utf-8');
        user = web3.Keypair.fromSecretKey(new Uint8Array(JSON.parse(userKeyPairString)));
        log(`${G}Using user wallet ${user.publicKey.toBase58()}`);
    } else {
        error('User wallet not provided or not found. Set USER_WALLET="path to id.json" in .env file')
        process.exit(1);
    }

    // Update this to the ID of your deployed program
    const wallet = new Wallet(user);
    // Create and set the provider
    const provider = new AnchorProvider(
        connection,
        wallet,
        // AnchorProvider.defaultOptions(),
    );
    setProvider(provider);

    // check balance
    log(`${G}Block height=${await connection.getBlockHeight()}`);
    log(`${G}SOL balance=${await connection.getBalance(user.publicKey).then((b) => b / LAMPORTS_PER_SOL)}`);

    // Load the program
    const program = workspace.SolXen as Program<SolXen>;
    log(`${G}Program ID=${program.programId}`);

    const [globalXnRecordAddress] = web3.PublicKey.findProgramAddressSync(
        [
            Buffer.from("xn-global-counter"),
        ],
        program.programId
    );

    if (cmd === Cmd.Balance) {

        const globalXnRecord = await program.account.globalXnRecord.fetch(globalXnRecordAddress);
        log(`${G}Global state: txs=${globalXnRecord.txs}, hashes=${globalXnRecord.hashes}, superhashes=${globalXnRecord.superhashes}, points=${globalXnRecord.points}, amp=${globalXnRecord.amp}, `)

    } else if (cmd === Cmd.Mine) {

        log(`${G}Running miner with params: cmd=${cmd}, address=${address}, priorityFee=${priorityFee}, runs=${runs}`);
        log(`${G}Using CU max=${units}`);
        const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
            units
        });
        const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFee
        });

        const [mint] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from("mint")],
            program.programId
        );

        const mintAccount = await getMint(provider.connection, mint);

        const associateTokenProgram = new web3.PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
        const userTokenAccount = utils.token.associatedAddress({
            mint: mintAccount.address,
            owner: user.publicKey
        })

        for (let run = 1; run <= runs; run++) {
            const ethAddress20 = Buffer.from(address.slice(2), 'hex')

            const [userXnRecordAccount] = web3.PublicKey.findProgramAddressSync(
                [
                    Buffer.from("sol-xen"),
                    ethAddress20,
                    user.publicKey.toBuffer()
                ],
                program.programId
            );

            const globalXnRecord = await program.account.globalXnRecord.fetch(globalXnRecordAddress);
            const [userXnAddressRecords] = web3.PublicKey.findProgramAddressSync(
                [
                    Buffer.from("sol-xen-addr"),
                    Buffer.from(numToUint8Array(globalXnRecord.txs)),
                ],
                program.programId
            );

            const mintAccounts = {
                user: user.publicKey,
                mintAccount: mintAccount.address,
                userTokenAccount,
                userXnRecord: userXnRecordAccount,
                globalXnRecord: globalXnRecordAddress,
                userXnAddressRecords,
                tokenProgram: TOKEN_PROGRAM_ID,
                associateTokenProgram
            };
            const mintTx = await program.methods.mintTokens({address: Array.from(ethAddress20)}, globalXnRecord.txs)
                .accounts(mintAccounts)
                .signers([user])
                .preInstructions([modifyComputeUnits, addPriorityFee])
                .rpc();

            const userTokenBalance = await connection.getTokenAccountBalance(userTokenAccount);
            // const userXnRecord = await program.account.userXnRecord.fetch(userXnRecordAccount);
            const globalXnRecordNew = await program.account.globalXnRecord.fetch(globalXnRecordAddress);
            log(`${Y}Tx=${mintTx}, hashes=${globalXnRecordNew.hashes}, superhashes=${globalXnRecordNew.superhashes}, balance=${userTokenBalance.value.uiAmount}`);
        }
    } else {
        error('Unknown command:', cmd)
        process.exit(1)
    }

}

main().then(() => console.log('Finished'))
    .catch(err => console.error(err));
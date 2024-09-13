import { BigNumber, ethers } from "ethers";
import cron from "node-cron";
import { NonceManager } from "@ethersproject/experimental";

import { L1BitcoinDepositorABI } from "../interfaces/L1BitcoinDepositor";
import { L2BitcoinDepositorABI } from "../interfaces/L2BitcoinDepositor";
import { getJsonById, writeNewJsonDeposit } from "../utils/JsonUtils";
import { createDeposit } from "../utils/Deposits";
import { Deposit } from "../types/Deposit.type";
import { LogMessage } from "../utils/Logs";
import { TBTCVaultABI } from "../interfaces/TBTCVault";
import { cleanFinalizedDeposits, cleanQueuedDeposits } from "./CleanupDeposits";
import { attemptToInitializeDeposit, initializeDeposits } from "./InitializeDeposits";
import { attemptToFinalizeDeposit, finalizeDeposits } from "./FinalizeDeposits";
import { checkForPastDeposits } from "./CheckForPastDeposits";

// ---------------------------------------------------------------
// Environment Variables
// ---------------------------------------------------------------
const ARBITRUM_RPC: string = process.env.ARBITRUM_RPC || "";
const ETHEREUM_RPC: string = process.env.ETHEREUM_RPC || "";
const L1BitcoinDepositor_Address: string = process.env.L1BitcoinDepositor || "";
const L2BitcoinDepositor_Address: string = process.env.L2BitcoinDepositor || "";
const TBTCVaultAdress: string = process.env.TBTCVault || "";
const privateKey: string = process.env.PRIVATE_KEY || "";

export const TIME_TO_RETRY = 1000 * 60 * 5; // 5 minutes

// ---------------------------------------------------------------
// Providers
// ---------------------------------------------------------------
export const providerArb: ethers.providers.JsonRpcProvider = new ethers.providers.WebSocketProvider(ARBITRUM_RPC);
export const providerEth: ethers.providers.JsonRpcProvider = new ethers.providers.WebSocketProvider(ETHEREUM_RPC);

// ---------------------------------------------------------------
// Signers
// ---------------------------------------------------------------
const signerArb: ethers.Wallet = new ethers.Wallet(privateKey, providerArb);
const signerEth: ethers.Wallet = new ethers.Wallet(privateKey, providerEth);

//NonceManager Wallets
const nonceManagerArb = new NonceManager(signerArb);
const nonceManagerEth = new NonceManager(signerEth);

// ---------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------
export const L1BitcoinDepositor: ethers.Contract = new ethers.Contract(
	L1BitcoinDepositor_Address,
	L1BitcoinDepositorABI,
	nonceManagerEth
);

export const L2BitcoinDepositor: ethers.Contract = new ethers.Contract(
	L2BitcoinDepositor_Address,
	L2BitcoinDepositorABI,
	nonceManagerArb
);

export const TBTCVault: ethers.Contract = new ethers.Contract(TBTCVaultAdress, TBTCVaultABI, signerEth);

// ---------------------------------------------------------------
// Cron Jobs
// ---------------------------------------------------------------

/**
 * @name startCronJobs
 * @description Starts the cron jobs for finalizing and initializing deposits.
 */

export const startCronJobs = () => {
	//CRONJOBS
	LogMessage("Starting cron job setup...");

	// Every minute (but only launch after 5 minutes - Check TIME_TO_RETRY)
	cron.schedule("* * * * *", async () => {
		finalizeDeposits();
		initializeDeposits();
	});

	// Every 10 minutes (but only launch after specified times)
	cron.schedule("*/10 * * * *", async () => {
		cleanQueuedDeposits();
		cleanFinalizedDeposits();
	});

	// Set cron job to run every hour
	cron.schedule("0 * * * *", async () => {
		checkForPastDeposits({ pastTimeInHours: 24 });
	});

	LogMessage("Cron job setup complete.");
};

/**
 * @name createEventListeners
 * @description Sets up listeners for deposit initialization and finalization events.
 */
export const createEventListeners = () => {
	LogMessage("Setting up event listeners...");

	L2BitcoinDepositor.on("DepositInitialized", async (fundingTx, reveal, l2DepositOwner, l2Sender) => {
		try {
			LogMessage(`Received DepositInitialized event for Tx: ${fundingTx}`);
			const deposit: Deposit = createDeposit(fundingTx, reveal, l2DepositOwner, l2Sender);
			writeNewJsonDeposit(fundingTx, reveal, l2DepositOwner, l2Sender);
			LogMessage(`Initializing deposit | Id: ${deposit.id}`);
			await attemptToInitializeDeposit(deposit);
		} catch (error) {
			LogMessage(`Error in DepositInitialized handler: ${error}`);
		}
	});

	TBTCVault.on("OptimisticMintingFinalized", (minter, depositKey, depositor, optimisticMintingDebt) => {
		try {
			const BigDepositKey = BigNumber.from(depositKey);
			const deposit: Deposit | null = getJsonById(BigDepositKey.toString());
			if (deposit) attemptToFinalizeDeposit(deposit);
		} catch (error) {
			LogMessage(`Error in the OptimisticMintingFinalized handler: ${error}`);
		}
	});

	LogMessage("Event listeners setup complete.");
};

// ---------------------------------------------------------------

import { Connection, PublicKey } from "@solana/web3.js";
import { configDotenv } from "dotenv";
import { messageQueues, messageTimestamps } from "..";
import Token from "../models/token";
import TxnSignature from "../models/txnSignature";
import connectToDatabase from "./database";
configDotenv();

const dexscreenerUrl = "https://dexscreener.com/solana/";
const jupiterUrl = "https://jup.ag/swap/USDC-";
const txnUrl = "https://solscan.io/tx/";
const buyerUrl = "https://solscan.io/account/";

const getTokenInfo = async (tokenMint: string) => {
  const connection = new Connection(process.env.BACKEND_RPC!);

  const accountInfoPromise = connection.getParsedAccountInfo(
    new PublicKey(tokenMint)
  );
  const tokenPricePromise = fetch(
    `https://price.jup.ag/v6/price?ids=${tokenMint},SOL`
  ).then((res) => res.json());

  const [accountInfoResult, tokenPriceResult]: [any, any] =
    await Promise.allSettled([accountInfoPromise, tokenPricePromise]);

  if (
    accountInfoResult.status !== "fulfilled" ||
    !accountInfoResult.value.value
  ) {
    throw new Error("Account info not found");
  }

  const accountInfo = (accountInfoResult.value.value?.data as any).parsed.info;
  const decimals = accountInfo.decimals;
  const totalSupply = parseInt(accountInfo.supply) / 10 ** decimals;

  if (
    tokenPriceResult.status !== "fulfilled" ||
    !tokenPriceResult.value.data[tokenMint]
  ) {
    throw new Error("Token price not found");
  }

  const tokenPrice = tokenPriceResult.value.data[tokenMint].price;
  const solPrice = tokenPriceResult.value.data.SOL.price;

  if (!totalSupply) throw new Error("Total supply not found");
  const marketCap = Math.floor(totalSupply * tokenPrice).toLocaleString();

  return { marketCap, tokenPrice, solPrice };
};

const callback = async (data: any) => {
  try {
    if (data.transaction.meta.err) return;

    const txnSignature = data.signature;

    await connectToDatabase();
    try {
      await TxnSignature.create({ txnSignature });
    } catch (error: any) {
      if (error.code !== 11000) console.log(txnSignature, error.message);
      return;
    }

    const signer = data.transaction.transaction.message.accountKeys.find(
      (acc: any) => acc.signer
    ).pubkey;

    const tokenChanges: Record<
      string,
      { isNewHolder: boolean; amount: number; positionIncrease: number }
    > = {};

    const preTokenBalances = data.transaction.meta.preTokenBalances;
    const postTokenBalances = data.transaction.meta.postTokenBalances;

    for (let i = 0; i < postTokenBalances.length; i++) {
      const postTokenBalance = postTokenBalances[i];
      const preTokenBalance = preTokenBalances.find(
        (t: any) => t.accountIndex === postTokenBalance.accountIndex
      );

      if (postTokenBalance.owner !== signer) continue;

      const mint = postTokenBalance.mint;

      const preTokenAmount = preTokenBalance?.uiTokenAmount?.uiAmount ?? 0;
      const postTokenAmount = postTokenBalance.uiTokenAmount.uiAmount;

      if (postTokenAmount === preTokenAmount) continue;

      const isNewHolder = preTokenAmount === 0;
      const amount = Math.abs(postTokenAmount - preTokenAmount);
      const positionIncrease = (amount * 100) / preTokenAmount;

      tokenChanges[mint] = {
        isNewHolder,
        amount,
        positionIncrease,
      };
    }

    // if (tokenChanges["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"])
    //   console.log("Token changes:", tokenChanges, txnSignature);

    const listeningGroups = await Token.find({
      tokenMint: { $in: Object.keys(tokenChanges) },
    }).lean();

    for (let i = 0; i < listeningGroups.length; i++) {
      const listeningGroup = listeningGroups[i];
      const tokenMint = listeningGroup.tokenMint;
      const tokenChange = tokenChanges[tokenMint];

      if (tokenChange.amount < listeningGroup.minValue) {
        continue;
      }

      const { marketCap, tokenPrice, solPrice } = await getTokenInfo(tokenMint);
      const {
        groupId,
        image,
        name,
        symbol,
        minValue,
        minValueEmojis,
        dexTUrl,
      } = listeningGroup;

      const amount = tokenChange.amount.toFixed(2);
      const positionIncrease = tokenChange.positionIncrease.toFixed(2);
      const spentUsd = (tokenChange.amount * tokenPrice).toFixed(2);
      const spentSol = (parseFloat(spentUsd) / solPrice).toFixed(2);

      let emojis = "";
      const times = Math.floor(tokenChange.amount / minValue);
      for (let i = 0; i < times; i++) emojis += minValueEmojis;

      emojis = emojis.match(/.{1,20}/g)?.join("\n") || "";

      const caption =
        `*${name.toUpperCase()} Buy!*\n` +
        `${emojis}\n\n` +
        `🔀 Spent *$${spentUsd} (${spentSol} SOL)*\n` +
        `🔀 Got *${amount} ${symbol}*\n` +
        `👤 [Buyer](${buyerUrl}${signer}) / [Txn](${txnUrl}${txnSignature})\n` +
        `🪙 *${
          tokenChange.isNewHolder
            ? "New Holder"
            : `Position +${positionIncrease}%`
        }*\n` +
        `💸 Market Cap *$${marketCap}*\n\n` +
        `[DexT](${dexTUrl}) |` +
        ` [Screener](${dexscreenerUrl}${txnSignature}) |` +
        ` [Buy](${jupiterUrl}${txnSignature})`;

      if (!messageQueues[groupId]) {
        messageQueues[groupId] = [];
      }

      if (!messageTimestamps[groupId]) {
        messageTimestamps[groupId] = [];
      }

      messageQueues[groupId].push({
        image,
        caption,
      });
    }
    return;
  } catch (error: any) {
    console.error(error.message);
    return;
  }
};

export default callback;

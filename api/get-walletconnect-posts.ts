// api/get-walletconnect-posts.ts
import { VercelRequest, VercelResponse } from "@vercel/node";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { getCoin } from "@zoralabs/coins-sdk";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const coinData = await getCoin({
      address: "0xb5330c936723d19954035e23a20570b511f47636", // walletconnect coin
      chain: base.id,
    });

    const comments = coinData?.data?.zora20Token?.zoraComments?.edges || [];

    const simplifiedPosts = comments.map(({ node }) => ({
      user: node.userProfile?.handle || node.userAddress,
      content: node.comment,
      timestamp: node.timestamp,
    }));

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({ posts: simplifiedPosts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch posts" });
  }
}

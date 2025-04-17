export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Only POST requests allowed");
  }

  const zoraRes = await fetch("https://api.zora.co/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(req.body),
  });

  const data = await zoraRes.json();

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.status(200).json(data);
}

const puppeteer = require("puppeteer");
const express = require("express");
const app = express();
app.use(express.static("public"));
require("dotenv").config();

let fetch;

(async () => {
  fetch = (await import("node-fetch")).default;
})();

let token = "";
let tokenExpires = 0;

async function automatedLogin() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  await page.goto(
    "https://auth.yverdon-energies.ch/auth/realms/EBP/protocol/openid-connect/auth?response_type=id_token%20token&client_id=ebp&redirect_uri=https%3A%2F%2Fmy.yverdon-energies.ch%2Febp%2Flogin&scope=openid%20profile%20email&nonce=UniqueNonceHere"
  );
  await page.type("#username", process.env.USERNAME);
  await page.type("#password", process.env.PASSWORD);
  await page.click("#kc-login");
  await page.waitForNavigation();

  const url = page.url();
  const token = url.match(/token=([^&]*)/)[1];
  const expires_in = url.match(/expires_in=([^&]*)/)[1];

  console.log("Token: " + token);
  await browser.close();

  tokenExpires = Date.now() + parseInt(expires_in) * 1000; // Update expiration time
  return { token, expires_in };
}

app.get("/meter-data", async (req, res) => {
  const { from, to } = req.query;

  if (!from || !to) {
    return res
      .status(400)
      .json({ error: "Please provide both from and to dates." });
  }

  if (!token || Date.now() >= tokenExpires) {
    try {
      const auth = await automatedLogin();
      token = auth.token;
    } catch (error) {
      console.error(error);
      return res.status(403).json({ error: "Failed to authenticate" });
    }
  }

  try {
    const data = await fetchMeterData(token, from, to);

    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

app.get("/meter-sum", async (req, res) => {
  const { from, to } = req.query;

  if (!from || !to) {
    return res
      .status(400)
      .json({ error: "Please provide both from and to dates." });
  }

  if (!token || Date.now() >= tokenExpires) {
    try {
      const auth = await automatedLogin();
      token = auth.token;
    } catch (error) {
      console.error(error);
      return res.status(403).json({ error: "Failed to authenticate" });
    }
  }

  try {
    const data = await fetchMeterData(token, from, to);

    const sum = data.reduce((acc, item) => acc + item.y, 0);

    res.json(sum);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

async function fetchMeterData(token, from, to) {
  const url =
    `https://backend.yverdon-energies.ch/ebp/meterdatavalues?meteringpoint=` +
    process.env.METERINGPOINT +
    `&dateFrom=${new Date(from).toISOString()}&dateTo=${new Date(
      to
    ).toISOString()}&intervall=0`;

  console.log(url);

  return fetch(url, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + token,
    },
  }).then(async (response) => {
    response = await response.json();
    var data = response[0].data.filter((item) => item.y !== null);
    return data;
  });
}

app.get("/", (req, res) => {
  res.sendFile("index.html", { root: __dirname + "/public" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

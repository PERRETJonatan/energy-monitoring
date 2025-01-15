const puppeteer = require("puppeteer");
const express = require("express");
const cron = require("node-cron");
const app = express();
app.use(express.static("public"));
require("dotenv").config();

let fetch;

(async () => {
  fetch = (await import("node-fetch")).default;
})();

let token = "";
let tokenExpires = 0;

// Fetch meter data every day at 00:15
cron.schedule("15 0 * * *", async () => {
// Every 10 seconds (for testing)
//cron.schedule("*/10 * * * * *", async () => {
  console.log("Fetching meter data...");

  // Correctly setting the 'yesterday' date
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  console.log("Yesterday: " + yesterday);
  console.log("Today: " + today);

  try {
    if (!token || Date.now() >= tokenExpires) {
      try {
        const auth = await automatedLogin();
        token = auth.token;
      } catch (error) {
        console.error(error);
        return res.status(403).json({ error: "Failed to authenticate" });
      }
    }
    // Assuming fetchMeterData is defined and token is available
    const data = await fetchMeterData(token, yesterday, today);
    //console.log(data);

    // store the sum of the data in a database
    const sum = data.reduce((acc, item) => acc + item.y, 0);
    console.log("Sum: " + sum);

    // Write the sum and the date to InfluxDB
    writeToInfluxDB(from, sum);
  } catch (error) {
    console.error("Failed to fetch meter data:", error);
  }
});

// Configure your InfluxDB connection here
const url = process.env.INFLUX_URL;
const influxToken = process.env.INFLUX_TOKEN;
const org = process.env.INFLUX_ORG;
const bucket = process.env.INFLUX_BUCKET;
const { InfluxDB, Point } = require("@influxdata/influxdb-client");
const client = new InfluxDB({ url, token: influxToken });
const writeApi = client.getWriteApi(org, bucket);

// Function to write data to InfluxDB
async function writeToInfluxDB(date, sum) {
  const point = new Point("meter_sum")
    .tag("unit", "energy")
    .floatField("sum", sum)
    .timestamp(date);

  if (!writeApi) {
    console.error("writeApi is not available");
    return;
  }

  await writeApi.writePoint(point);
  console.log(`Data written to InfluxDB: Sum ${sum} on ${date.toISOString()}`);
}

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

  //console.log("Token: " + token);
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

app.get("/compute-all-meter-sum", async (req, res) => {
  const daysToCompute = req.query.days || 1;

  console.log("Fetching meter data...");

  for (let i = 0; i < daysToCompute; i++) {
    const to = new Date(new Date() - i * 24 * 60 * 60 * 1000);
    to.setHours(23, 59, 0, 0);

    const from = new Date(to);
    from.setHours(0, 0, 0, 0);


    console.log("From: " + from);
    console.log("to: " + to);

    try {
      if (!token || Date.now() >= tokenExpires) {
        try {
          const auth = await automatedLogin();
          token = auth.token;
        } catch (error) {
          console.error(error);
          return res.status(403).json({ error: "Failed to authenticate" });
        }
      }
      // Assuming fetchMeterData is defined and token is available
      const data = await fetchMeterData(token, from, to);
      //console.log(data);

      // store the sum of the data in a database
      const sum = data.reduce((acc, item) => acc + item.y, 0);
      console.log("Sum: " + sum);

      // Write the sum and the date to InfluxDB
      await writeToInfluxDB(from, sum);
    } catch (error) {
      console.error("Failed to fetch meter data:", error);
    }
  }
  res.status(200).json({ message: "Data computed and stored in InfluxDB" });
});

function toLocalISOString(date) {
  const offset = date.getTimezoneOffset();
  const adjustedDate = new Date(date.getTime() - offset * 60 * 1000);
  return adjustedDate.toISOString().slice(0, -1); // Removing the 'Z' to not imply UTC
}

async function fetchMeterData(token, from, to) {
  const url =
    `https://backend.yverdon-energies.ch/ebp/meterdatavalues?meteringpoint=` +
    process.env.METERINGPOINT +
    `&dateFrom=${toLocalISOString(from)}&dateTo=${toLocalISOString(
      to
    )}&intervall=0`;

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

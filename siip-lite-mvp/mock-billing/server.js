const express = require("express");
const app = express();
const billingPort = Number.parseInt(process.env.PORT || process.env.BILLING_PORT || "3001", 10);

app.use(express.json());

app.post("/receive", (req, res) => {
  console.log("💰 Billing received request:", req.body);

  res.json({
    message: "Payment processed ✅",
  });
});

app.listen(billingPort, () => {
  console.log(`Mock Billing running on http://localhost:${billingPort}`);
});
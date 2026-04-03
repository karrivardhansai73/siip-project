const express = require("express");
const app = express();

app.use(express.json());

app.post("/receive", (req, res) => {
  console.log("💰 Billing received request:", req.body);

  res.json({
    message: "Payment processed ✅",
  });
});

app.listen(3001, () => {
  console.log("Mock Billing running on http://localhost:3001");
});
import 'dotenv/config';
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// Health check route (Render needs the app to stay alive)
app.get("/", (req, res) => {
  res.send("Boostify server is running ✅");
});

// OPTIONAL: put your Discord bot / other code below this line
// Example:
// startBot();

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

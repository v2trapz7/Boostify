import 'dotenv/config';
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

const app = express();
const PORT = process.env.PORT || 3000;

// Health check route (Render needs the app to stay alive)
app.get("/", (req, res) => {
});

// OPTIONAL: put your Discord bot / other code below this line
// Example:
// startBot();

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

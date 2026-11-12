# NEON PONG — Online 1v1 multiplayer

**Real-time Pong on separate devices.** Unlike a single HTML file, this project includes a multiplayer game server. Both players visit the **same public site**. The first player creates a private room; the second opens the shared invite link (or enters the 6-character code). The match starts automatically.

## Features
- Two human players across devices/networks (no computer opponent)
- Private room codes and copyable invite links
- Real-time synchronized paddles, ball, scores, collisions and win condition
- First to seven points; both players can vote for rematch
- Controls: phone finger drag, PC mouse, W/S and up/down arrows
- Responsive neon design
- No database, accounts or npm dependencies
- Same-origin HTTP + WebSocket, working with HTTPS/WSS once hosted

## Put it on the internet (Render + GitHub)

1. Unzip the folder and upload **all files including `server.js`, `public/`, `package.json`** to a new GitHub repository. Do not upload only `index.html`.
2. Sign in to [Render](https://dashboard.render.com), then select **New → Web Service**.
3. Connect that GitHub repository. Set runtime to **Node**, build command `npm install`, start command `npm start`. Choose the Free instance type if available. Render detects `PORT`; no environment variables are required.
4. After deployment, visit your assigned address, such as `https://your-game.onrender.com`.
5. Click **Create private room**, copy the invite link, and send it to your friend. Your friend opens the link on another device. You will automatically play each other.

If you use Render's **Blueprint** option instead of manually creating a Web Service, `render.yaml` contains deployment settings.

**Important:** Static-only upload tools (like Netlify Drop for an ordinary HTML file) do not run this WebSocket server. Use a hosting provider supporting Node.js web services and WebSocket connections.

### How to add files to GitHub without programming
Open your newly created empty repository in GitHub → **Add file → Upload files** → drag in the files/folders from the unzipped project → Commit changes. (Some mobile browsers make folder uploads difficult; a computer is easiest.)

## Run locally (test on your computer)
Requires Node.js v20 or newer:

```bash
npm start
```

Then open `http://localhost:3000` in two different browser tabs to test. For internet play, deploy the whole folder using the instructions above.

## Technical notes
- Game state is **authoritative on the server** (60 Hz simulation, 30 Hz updates) using WebSockets.
- Rooms exist only in RAM and are deleted when both players leave. If the server restarts or a free host sleeps, the room is lost. Create a new room.
- Only two players are allowed in a room. Invite codes are not authentication; share them only with people you want to play.
- Intended for small friend games, not competitive anti-cheat or high-scale hosting.
- If a player disconnects, the game pauses. They can rejoin using the room code if at least one player remains.
- Free hosting may sleep after inactivity; the first visitor might have to wait for the server to wake up.
- `npm test` runs the local WebSocket multiplayer test suite.

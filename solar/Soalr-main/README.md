# Growatt SPF 5000ES Solar Dashboard

Real-time solar energy dashboard for the Growatt SPF 5000ES inverter.

## Features
- Live energy flow visualization (PV → Battery → Load → Grid)
- Battery SOC, voltage, charge/discharge monitoring
- PV generation, load consumption, grid import/export
- Auto-refresh every 5 minutes
- Dark industrial theme, mobile responsive

## Local Development

1. Copy `.env.example` to `.env` and fill in your Growatt credentials:
   ```
   cp .env.example .env
   nano .env
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Start the server:
   ```
   npm start
   ```

4. Open `http://localhost:3000`

---

## Deploy to cPanel (Node.js)

### Step 1: Create Subdomain
1. Log into cPanel
2. Go to **Domains** → **Subdomains** (or **Domains** → **Create a New Domain**)
3. Create: `solar.sagrinding.co.za`
4. Set document root to: `/home/yourusername/solar.sagrinding.co.za`

### Step 2: Upload Files
1. Go to **File Manager** in cPanel
2. Navigate to `/home/yourusername/solar.sagrinding.co.za`
3. Upload ALL project files:
   - `server.js`
   - `package.json`
   - `.env` (create this from .env.example with your real credentials)
   - `public/` folder (with index.html, style.css, app.js)

Your file structure should look like:
```
solar.sagrinding.co.za/
├── server.js
├── package.json
├── .env
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

### Step 3: Setup Node.js App
1. In cPanel, go to **Software** → **Setup Node.js App**
2. Click **Create Application**
3. Configure:
   - **Node.js version**: 18.x or 20.x (latest available)
   - **Application mode**: Production
   - **Application root**: `solar.sagrinding.co.za` (the folder path)
   - **Application URL**: `solar.sagrinding.co.za`
   - **Application startup file**: `server.js`
4. Click **Create**
5. After creation, click **Run NPM Install** (button at top of the app page)

### Step 4: Setup Environment Variables
In the Node.js app settings page:
1. Scroll to **Environment Variables**
2. Add:
   - `GROWATT_USERNAME` = your ShinePhone username
   - `GROWATT_PASSWORD` = your ShinePhone password
3. Click **Save** and then **Restart App**

Alternatively, if your cPanel Node.js setup doesn't have env variable UI,
create the `.env` file in the application root with your credentials.

### Step 5: Verify
1. Open `https://solar.sagrinding.co.za`
2. Click **Connect**
3. You should see your plant name, devices, and live energy data

---

## Troubleshooting

### "Login failed" error
- Verify your credentials work on the ShinePhone app
- The password is your ShinePhone password (not the API token)
- Check `.env` file has no extra spaces or quotes

### "No devices found"
- Click the **Debug API** link in the footer
- Check the raw response to see what Growatt returns
- Your SPF 5000ES should appear as a storage device

### Data shows all zeros
- This is normal at night when PV power is 0
- Check the Debug API for raw data — some field names may differ
- Battery SOC and voltage should always show values if the system is running

### cPanel: App won't start
- Check error logs in cPanel → **Metrics** → **Errors**
- Ensure Node.js version is 18+ (fetch API needed)
- Try restarting the app from the Node.js setup page

### cPanel: 503 or proxy errors
- The Node.js app may take 10-15 seconds to start
- Check that the startup file is set to `server.js`
- Check that npm install completed without errors

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/connect` | Login and discover plant/devices |
| `GET /api/data` | Get latest dashboard data (cached 60s) |
| `GET /api/status` | Check connection status |
| `GET /api/debug` | Raw API responses for debugging |

---

## Technical Notes

- Uses Growatt's Classic/Legacy API (same as ShinePhone app)
- Password is hashed with Growatt's modified MD5 algorithm
- Session auto-refreshes every 30 minutes
- Data cached for 60 seconds to respect rate limits
- SPF 5000ES is queried as a storage device (type 2)

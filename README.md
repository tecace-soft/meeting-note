# Meeting Note App

Audio transcription and MS Teams chat integration application.

## Features

- **MS Teams Authentication**: Sign in with your Microsoft account
- **Audio File Upload**: Upload audio files for transcription
- **Teams Chats**: View and access your MS Teams conversations

## Setup

### 1. Azure AD App Registration

1. Go to [Azure Portal](https://portal.azure.com)
2. Navigate to Azure Active Directory > App registrations
3. Click "New registration"
4. Configure:
   - **Name**: Meeting Note App
   - **Supported account types**: Accounts in any organizational directory (Multi-tenant)
   - **Redirect URI**: Select "Single-page application (SPA)" and enter `http://localhost:5174`
5. Click "Register"
6. Copy the **Application (client) ID**

### 2. Configure API Permissions

In your registered app:
1. Go to "API permissions"
2. Click "Add a permission" > "Microsoft Graph" > "Delegated permissions"
3. Add these permissions:
   - `User.Read`
   - `Chat.Read`
   - `Chat.ReadWrite`
   - `ChatMessage.Read`
4. Click "Grant admin consent" (if you have admin rights)

### 3. Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:
```
VITE_MSAL_CLIENT_ID=your-client-id-from-step-1
VITE_MSAL_AUTHORITY=https://login.microsoftonline.com/common
VITE_MSAL_REDIRECT_URI=http://localhost:5174
VITE_WORKFLOW_API_URL=http://localhost:8787
```

### 4. Install Dependencies

The web app lives at the repo root (not a subfolder), so install from there:

```bash
npm install
```

### 5. Run Development Server

```bash
npm run dev
```

The app will be available at `http://localhost:5174`

### 6. Run Workflow Server

The main audio summarization flow uses the dedicated backend in `workflow-server`.

```bash
cd workflow-server
npm install
npm run dev
```

The workflow server requires:

```
SUPABASE_URL=your-supabase-url
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
ASSEMBLYAI_API_KEY=your-assemblyai-api-key   # transcription (AssemblyAI, not Gemini)
GEMINI_API_KEY=your-gemini-api-key           # summary / insight / RCA
GEMINI_SUMMARY_MODEL=gemini-2.5-flash-lite
WORKFLOW_FETCH_HEADERS_TIMEOUT_MS=1200000
WORKFLOW_FETCH_BODY_TIMEOUT_MS=1200000
```

## Project Structure

```
<repo root>/
├── src/
│   ├── config/
│   │   └── msalConfig.ts      # MSAL configuration
│   ├── context/
│   │   └── AuthContext.tsx    # Authentication context
│   ├── pages/
│   │   ├── Login.tsx          # Login page with MS Teams auth
│   │   └── TranscriptionSummary.tsx  # Main dashboard
│   ├── services/
│   │   └── graphService.ts    # MS Graph API calls
│   ├── styles/
│   │   └── theme.css          # Theme CSS variables
│   ├── theme/
│   │   └── ThemeProvider.tsx  # Dark/Light theme support
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── .env.example
├── package.json
└── README.md
```

## Technology Stack

- React 18
- TypeScript
- Vite
- Tailwind CSS
- MSAL (Microsoft Authentication Library)
- Microsoft Graph API
- Lucide React (icons)


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
```

### 4. Install Dependencies

```bash
cd apps/meeting-note
npm install
```

### 5. Run Development Server

```bash
npm run dev
```

The app will be available at `http://localhost:5174`

## Project Structure

```
apps/meeting-note/
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


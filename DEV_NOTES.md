# Meeting Note App - Development Notes

## Project Overview

Meeting Note is a web application for audio transcription and Microsoft Teams chat integration. The app allows users to upload audio files, generate transcriptions and summaries, manage meeting notes, and integrate with MS Teams conversations.

**Deployment**: Custom domain `meetingnote.tecace.com` (previously `meeting-note-fxms.onrender.com`)  
**Tech Stack**: React 18, TypeScript, Vite, Tailwind CSS, MSAL, Microsoft Graph API, Supabase

---

## Architecture & Tech Stack

### Core Technologies
- **Frontend Framework**: React 18 with TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS with custom CSS variables for theming
- **Authentication**: Microsoft Authentication Library (MSAL) for Azure AD
- **API Integration**: Microsoft Graph API for Teams data
- **Database**: Supabase (PostgreSQL)
- **Icons**: Lucide React
- **Markdown**: react-markdown with remark-gfm
- **File Compression**: JSZip for bulk downloads

### Project Structure
```
src/
├── config/
│   ├── msalConfig.ts          # MSAL configuration for Azure AD
│   └── supabaseConfig.ts      # Supabase client configuration
├── context/
│   └── AuthContext.tsx        # Authentication context provider
├── pages/
│   ├── Login.tsx              # Login page with Microsoft auth
│   ├── TranscriptionSummary.tsx  # Main page for transcription workflow
│   ├── SummaryHistory.tsx     # History page with search, sort, bulk actions
│   └── SaveSummary.tsx        # Page for saving/editing summaries
├── services/
│   └── graphService.ts        # Microsoft Graph API service
├── styles/
│   └── theme.css              # Theme CSS variables and custom styles
├── theme/
│   └── ThemeProvider.tsx      # Dark/Light theme provider
└── images/
    ├── meeting note ICON.svg
    ├── meeting note dark mode.svg
    └── meeting note light mode.svg
```

---

## Key Features & Development History

### 1. Authentication & User Management
- **Microsoft SSO**: Integrated MSAL for Microsoft account authentication
- **User Context**: Centralized authentication state via `AuthContext`
- **Token Management**: Automatic token refresh and silent acquisition

### 2. Audio Transcription Workflow
- **File Upload**: Support for audio file uploads
- **Transcription Processing**: Integration with n8n webhook workflow
- **Summary Generation**: Automatic summary generation from transcriptions
- **Real-time Updates**: Status tracking for transcription and summary generation

### 3. Summary Management
- **Summary History Page**: Comprehensive note management interface
  - Search functionality (by name, tags, ID, user_name)
  - Sort options (Date, Name, Creator) with ascending/descending toggle
  - Bulk actions (select all, delete, download)
  - Individual row actions (edit, delete, download, expand)
- **Summary Editing**: 
  - Original summaries stored in `note.summary` (immutable)
  - Edits saved to `note.summary_edit` column
  - Display logic: `note.summary_edit || note.summary`

### 4. OneDrive Integration
- **File Browser**: Full OneDrive file and folder navigation
  - Browse root folder and subfolders
  - Breadcrumb navigation with clickable path
  - Sort: folders first, then files alphabetically
  - Display file metadata (size, date, type)
- **Folder Management**:
  - Create new folders in current location
  - Navigate into folders
  - Rename folders and files
  - Delete folders and files (with confirmation)
- **File Saving**:
  - **Save Summary**: Upload summary as markdown file (`.md`)
  - **Save Transcript**: Upload transcript as markdown file (`.md`)
  - **Save Audio**: Upload original audio file from Supabase storage
  - Custom filename input for each file type
  - Success indicators after upload
  - Automatic folder refresh after save
- **Implementation Details**:
  - Uses Microsoft Graph API `/me/drive` endpoints
  - Text files uploaded via `uploadTextFile` function
  - Binary files (audio) uploaded directly via Graph API client
  - Default filenames: `Meeting_Note_YYYYMMDD.md`, `Meeting_Transcript_YYYYMMDD.md`
  - Conflict behavior: auto-rename on duplicate names

### 5. Summary Forwarding to MS Teams
- **Forward Functionality**: Send generated summaries to MS Teams chats
  - Select chat from Teams Chats list
  - Convert markdown summary to HTML for Teams formatting
  - Send as HTML message with "Meeting Note:" header
  - Update note record with `chat_id` in Supabase
- **User Experience**:
  - Forward button appears when summary is available
  - Disabled state when no chat selected
  - Loading state during send operation
  - Success indicator (green background) for 3 seconds
  - Error handling with user-friendly alerts
- **Technical Implementation**:
  - Uses `sendChatMessage` from Graph API service
  - Markdown conversion via `marked` library
  - HTML content type for rich formatting in Teams
  - Updates `note.chat_id` field to track forwarded notes

### 6. Mobile Responsiveness
- **Mobile Detection**: Custom `useMobile` hook (removed, functionality integrated directly)
- **Responsive Layouts**: Separate mobile-friendly UIs for all pages
- **Safe Area Support**: iOS safe area insets using `env(safe-area-inset-bottom)`
- **Mobile-Specific Features**:
  - Simplified headers (user name/initial hidden on mobile)
  - Full-width action buttons
  - Optimized spacing and touch targets
  - Bottom padding adjustments for mobile browsers

### 7. UI/UX Enhancements

#### Header Navigation
- **Brand Icon**: Clickable brand icon in top-left (navigates to transcription-summary)
- **Navigation Icons**: 
  - `NotebookPen`: Navigate to transcription-summary
  - `History`: Navigate to summary-history
  - `HardDrive`: Navigate to save-summary
- **Theme Toggle**: Sun/Moon icons for light/dark mode
- **User Info**: Hidden on mobile, visible on desktop

#### Summary History Page Features
- **Row Selection**: Checkboxes for individual and bulk selection
- **Hover Effects**: 
  - Chevron icon color change on row hover
  - Border color change for clickable sections only
- **Tag Management**:
  - Dynamic tag display with overflow handling
  - Ellipsis (`...`) tag for overflow with tooltip
  - "+" button always positioned after tags
- **Expandable Rows**: Click entire row to expand/collapse details
- **Bulk Actions**:
  - Bulk delete with confirmation modal
  - Bulk download with floating menu (Summary, Transcript, Audio)
  - JSZip integration for zip file creation

#### Search & Filter
- **Keyword Search**: Filters by `note.name`, `note.tags`, `note.id`, `note.user_name`
- **Sort Options**: 
  - Date (oldest/newest)
  - Name (A-Z/Z-A)
  - Creator (A-Z/Z-A)
- **UI Controls**: Search bar, sort dropdown, ascending/descending toggle

### 8. Theme System
- **Dark/Light Mode**: Full theme support with CSS variables
- **Theme Persistence**: Theme preference stored and restored
- **Brand Assets**: Theme-specific brand icons (dark/light mode SVGs)
- **Custom Checkboxes**: Theme-aware checkbox styling

---

## Database Schema

### Note Table (Supabase)
```typescript
interface Note {
  id: string;
  name: string;
  summary: string;           // Original generated summary (immutable)
  summary_edit?: string;      // User-edited summary
  transcript?: string;
  tags?: string[];
  user_id: string;
  user_name?: string;
  created_at?: string;
  audio_url?: string;
  publicUrl?: string;
  chat_id?: string;          // MS Teams chat ID when summary is forwarded
}
```

**Key Design Decisions**:
- `summary`: Preserves original AI-generated content
- `summary_edit`: Stores all user modifications
- Display logic prioritizes edited version: `note.summary_edit || note.summary`
- `chat_id`: Tracks which Teams chat the summary was forwarded to

---

## Authentication Flow

### MSAL Configuration
- **Client ID**: From Azure AD app registration
- **Authority**: `https://login.microsoftonline.com/common` (multi-tenant)
- **Redirect URI**: Currently uses environment variable (should be dynamic for custom domains)
- **Scopes**: 
  - `User.Read`: User profile information
  - `Chat.Read`, `Chat.ReadWrite`: MS Teams chat access
  - `ChatMessage.Read`: Read chat messages
  - `Files.ReadWrite`, `Files.ReadWrite.All`: OneDrive file access

### Authentication Context
- **Login**: Popup-based authentication
- **Logout**: Popup-based with redirect to home
- **Token Acquisition**: Silent first, popup fallback
- **User State**: Managed via MSAL accounts

---

## Key Components

### Pages

#### Login.tsx
- Microsoft authentication
- Theme-specific brand icons
- Theme toggle with outline icons
- No header branding (cleaner design)

#### TranscriptionSummary.tsx
- **Main Transcription Workflow**: 
  - Audio file upload (drag & drop or file picker)
  - Real-time status updates (uploading, processing, completed)
  - Summary display and editing
- **MS Teams Integration**:
  - Teams Chats list display
  - Chat selection for forwarding summaries
  - Forward summary to selected chat
  - Chat message sending via Graph API
- **OneDrive Integration**:
  - "Save to OneDrive" button navigates to SaveSummary page
  - Passes note_id, audio_url, and audio_name as URL parameters
- **Navigation**: Links to history and save pages

#### SummaryHistory.tsx
- **Most complex page** with extensive features:
  - Search and filter
  - Sort functionality
  - Bulk selection and actions
  - Individual row management
  - Expandable rows
  - Tag management
  - Download options (Summary, Transcript, Audio)

#### SaveSummary.tsx
- **OneDrive File Browser**: Full file management interface
  - Browse folders with breadcrumb navigation
  - Create, rename, delete folders and files
  - Save summary, transcript, and audio files to OneDrive
  - File metadata display (size, date, type)
  - Custom filename inputs for each file type
- **Note Integration**: Fetches note data from Supabase when `note_id` provided
- **Audio Handling**: Downloads audio from Supabase storage before uploading to OneDrive
- **Navigation**: Links to transcription-summary and summary-history pages

### Context Providers

#### AuthContext
- User authentication state
- Login/logout functions
- Access token management
- User information (id, displayName, email)

#### ThemeProvider
- Dark/light mode state
- Theme persistence
- CSS variable updates

### Services

#### graphService.ts
- **MS Teams Functions**:
  - `getTeamsChats`: Fetch user's Teams chats
  - `getChatMessages`: Get messages from a specific chat
  - `sendChatMessage`: Send message to Teams chat (text or HTML)
  - `getCurrentUser`: Get authenticated user info
- **OneDrive Functions**:
  - `getOneDriveRoot`: Get root folder contents
  - `getOneDriveFolderContents`: Get folder contents by ID
  - `getOneDriveItem`: Get item details by ID
  - `createOneDriveFolder`: Create new folder
  - `deleteOneDriveItem`: Delete file or folder
  - `renameOneDriveItem`: Rename file or folder
  - `uploadTextFile`: Upload text/markdown file
- **Graph Client**: Centralized Microsoft Graph API client initialization

---

## Styling & CSS

### Theme CSS Variables
Located in `src/styles/theme.css`:
- `--bg`, `--bg-secondary`: Background colors
- `--text`, `--text-secondary`: Text colors
- `--border`: Border colors
- `--accent`: Accent color for highlights
- Theme-aware checkbox styling
- Mobile safe area padding

### Mobile-Specific Classes
- `.mobile-safe-bottom`: Safe area bottom padding
- `.mobile-bottom-padding`: Main content bottom padding
- Uses `max()` CSS function with `env(safe-area-inset-bottom)`

### Custom Checkbox Styling
- Theme-aware backgrounds
- Custom checkmark SVG
- Indeterminate state support
- Smooth transitions

---

## File Operations

### Download Functionality
- **Individual Downloads**: Summary (markdown), Transcript (markdown), Audio (original file)
- **Bulk Downloads**: JSZip integration for creating zip archives
- **File Handling**: Blob creation, URL management, cleanup

### OneDrive File Operations
- **Text File Upload**: `uploadTextFile` function for markdown files (summary, transcript)
- **Binary File Upload**: Direct Graph API client for audio files
- **File Management**: 
  - Create folders with conflict resolution (auto-rename)
  - Rename files and folders
  - Delete files and folders (with confirmation)
  - Navigate folder hierarchy
- **File Metadata**: Display size, creation date, modification date, file type

### Audio Processing
- File upload to Supabase storage
- Public URL generation
- Integration with n8n webhook for transcription
- Audio file download from Supabase for OneDrive upload

---

## Deployment & Configuration

### Vite Configuration
- **Port**: 5174
- **Host**: 0.0.0.0 (accessible from network)
- **Allowed Hosts**: 
  - `meeting-note-fxms.onrender.com`
  - `meetingnote.tecace.com` (custom domain)

### Environment Variables
- `VITE_MSAL_CLIENT_ID`: Azure AD app client ID
- `VITE_MSAL_AUTHORITY`: Azure AD authority URL
- `VITE_MSAL_REDIRECT_URI`: Redirect URI for authentication
- Supabase URL and anon key (configured in `supabaseConfig.ts`)

### Viewport Configuration
- `viewport-fit=cover` for iOS safe area support
- Responsive meta tags

---

## Known Issues & Solutions

### Issue: Mobile Bottom Margin Not Applied
**Problem**: Bottom margin appeared in browser dev tools but not on actual devices  
**Solution**: Implemented `env(safe-area-inset-bottom)` with `max()` CSS function for dynamic padding

### Issue: Content Width Inconsistency
**Problem**: Page width shrunk when no data displayed or loading  
**Solution**: Applied `width: 100%`, `minWidth: 0`, `flex-shrink-0` to containers including loading/empty states

### Issue: MSAL Redirect URI for Custom Domain
**Problem**: Authentication popup showed old Render domain instead of custom domain  
**Solution**: Should use dynamic `window.location.origin` (currently uses env variable - needs update)

### Issue: JSZip Module Not Found
**Problem**: Build failed with `Cannot find module 'jszip'`  
**Solution**: Added `jszip` to dependencies and `@types/jszip` to devDependencies

### Issue: Custom Domain Blocked
**Problem**: Custom domain access blocked by Vite  
**Solution**: Added domain to `allowedHosts` in `vite.config.ts`

---

## Development Decisions

### Mobile-First Approach
- Separate mobile UIs for better UX
- Touch-optimized interactions
- Simplified layouts for small screens

### Data Immutability
- Original summaries preserved in `note.summary`
- Edits stored separately in `note.summary_edit`
- Allows reverting to original if needed

### Bulk Operations
- Efficient selection with Set data structure
- Confirmation modals for destructive actions
- Zip file creation for bulk downloads

### Search & Sort
- Client-side filtering for performance
- Memoized filtered/sorted results
- Flexible search across multiple fields

### Tag Management
- Dynamic overflow handling
- Tooltip for truncated tags
- Always-visible add button

---

## Future Considerations

### Authentication
- [ ] Make redirect URI dynamic based on current domain
- [ ] Support multiple redirect URIs in Azure AD

### Performance
- [ ] Implement pagination for large note lists
- [ ] Add virtual scrolling for long lists
- [ ] Optimize image loading

### Features
- [ ] Chat integration UI improvements (currently disabled with "Coming soon" tooltip)
- [ ] Advanced filtering options
- [ ] Export functionality (PDF, DOCX)
- [ ] Tag autocomplete/suggestions
- [ ] Note sharing/collaboration
- [ ] OneDrive folder selection for bulk saves
- [ ] OneDrive file preview
- [ ] Forward summary to multiple chats
- [ ] Schedule automatic forwarding

### Mobile
- [ ] Offline support
- [ ] Push notifications
- [ ] Progressive Web App (PWA) features

---

## Dependencies

### Production
- `@azure/msal-browser`: ^3.6.0
- `@azure/msal-react`: ^2.0.8
- `@microsoft/microsoft-graph-client`: ^3.0.7
- `@supabase/supabase-js`: ^2.87.1
- `lucide-react`: ^0.545.0
- `marked`: ^17.0.1
- `react`: ^18.2.0
- `react-dom`: ^18.2.0
- `react-markdown`: ^10.1.0
- `react-router-dom`: ^6.8.1
- `remark-gfm`: ^4.0.1
- `jszip`: ^3.10.1

### Development
- TypeScript: ^5.0.2
- Vite: ^4.4.5
- Tailwind CSS: ^3.3.3
- ESLint with TypeScript plugins

---

## Notes

- All pages support both desktop and mobile views
- Theme system is fully integrated across all components
- Navigation is consistent across pages with brand icon and navigation icons
- Summary editing preserves original content while allowing modifications
- Bulk operations provide efficient management of multiple notes
- Search and sort functionality enhances note discovery

---

*Last Updated: Based on development history through custom domain implementation*


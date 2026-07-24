import { Client } from '@microsoft/microsoft-graph-client';

export interface TeamsChat {
  id: string;
  topic: string | null;
  chatType: 'oneOnOne' | 'group' | 'meeting';
  createdDateTime: string;
  lastUpdatedDateTime: string;
  lastMessageDateTime?: string;
  members?: ChatMember[];
  webUrl?: string;
}

export interface ChatMember {
  id: string;
  displayName: string;
  email: string;
}

export interface ChatMessage {
  id: string;
  body: {
    content: string;
    contentType: string;
  };
  from: {
    user: {
      displayName: string;
      id: string;
    };
  } | null;
  createdDateTime: string;
}

export interface OutlookCalendarEvent {
  id: string;
  subject: string;
  start: {
    dateTime: string;
    timeZone: string;
  };
  end: {
    dateTime: string;
    timeZone: string;
  };
  isAllDay?: boolean;
  isCancelled?: boolean;
  location?: {
    displayName?: string;
  };
  organizer?: {
    emailAddress?: {
      name?: string;
      address?: string;
    };
  };
  webLink?: string;
  onlineMeeting?: {
    joinUrl?: string;
  } | null;
}

function getGraphClient(accessToken: string): Client {
  return Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    },
  });
}

export async function getOutlookCalendarEvents(
  accessToken: string,
  startDateTime: string,
  endDateTime: string,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
): Promise<OutlookCalendarEvent[]> {
  try {
    const client = getGraphClient(accessToken);
    const response = await client
      .api('/me/calendarView')
      .header('Prefer', `outlook.timezone="${timeZone}"`)
      .query({
        startDateTime,
        endDateTime,
      })
      .select('id,subject,start,end,isAllDay,isCancelled,location,organizer,webLink,onlineMeeting')
      .orderby('start/dateTime')
      .top(100)
      .get();

    return ((response.value ?? []) as OutlookCalendarEvent[]).filter((event) => !event.isCancelled);
  } catch (error) {
    console.error('Error fetching Outlook calendar events:', error);
    throw error;
  }
}

export async function getTeamsChats(accessToken: string): Promise<TeamsChat[]> {
  try {
    const client = getGraphClient(accessToken);
    
    // First get chats list
    const response = await client.api('/me/chats')
      .select('id,topic,chatType,createdDateTime,lastUpdatedDateTime,webUrl')
      .expand('members,lastMessagePreview')
      .top(50)
      .get();

    const chats = response.value
      .map((chat: any) => {
        // Use lastMessagePreview.createdDateTime if available, otherwise fall back
        const lastMsgTime = chat.lastMessagePreview?.createdDateTime;
        
        return {
          id: chat.id,
          topic: chat.topic,
          chatType: chat.chatType,
          createdDateTime: chat.createdDateTime,
          lastUpdatedDateTime: chat.lastUpdatedDateTime,
          lastMessageDateTime: lastMsgTime || null,
          webUrl: chat.webUrl,
          members: chat.members?.map((member: any) => ({
            id: member.userId || member.id || '',
            displayName: member.displayName || 'Unknown',
            email: member.email || '',
          })) || [],
        };
      })
      // Filter out chats with no messages (empty calendar event chats)
      .filter((chat: TeamsChat) => {
        // Only include chats that have had at least one message
        const hasMessage = chat.lastMessageDateTime !== null;
        
        if (!hasMessage) return false;
        
        // For meeting chats, also filter out old ones with only system messages
        if (chat.chatType === 'meeting') {
          const lastMessageDate = new Date(chat.lastMessageDateTime!);
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          
          // Filter out meeting chats older than 30 days
          if (lastMessageDate < thirtyDaysAgo) return false;
        }
        
        return true;
      });

    // Sort by lastMessageDateTime (all chats now have this)
    return chats.sort((a: TeamsChat, b: TeamsChat) => {
      return new Date(b.lastMessageDateTime!).getTime() - new Date(a.lastMessageDateTime!).getTime();
    });
  } catch (error) {
    console.error('Error fetching Teams chats:', error);
    throw error;
  }
}

export async function getChatMessages(
  accessToken: string,
  chatId: string
): Promise<ChatMessage[]> {
  try {
    const client = getGraphClient(accessToken);
    const response = await client.api(`/me/chats/${chatId}/messages`)
      .select('id,body,from,createdDateTime')
      .top(50)
      .get();

    // Sort by createdDateTime client-side
    return response.value.sort((a: ChatMessage, b: ChatMessage) =>
      new Date(b.createdDateTime).getTime() - new Date(a.createdDateTime).getTime()
    );
  } catch (error) {
    console.error('Error fetching chat messages:', error);
    throw error;
  }
}

export async function getCurrentUser(accessToken: string) {
  try {
    const client = getGraphClient(accessToken);
    const user = await client.api('/me').get();
    return user;
  } catch (error) {
    console.error('Error fetching current user:', error);
    throw error;
  }
}

export async function sendChatMessage(
  accessToken: string,
  chatId: string,
  message: string,
  contentType: 'text' | 'html' = 'text'
): Promise<void> {
  try {
    const client = getGraphClient(accessToken);
    await client.api(`/chats/${chatId}/messages`)
      .post({
        body: {
          content: message,
          contentType: contentType,
        },
      });
  } catch (error) {
    console.error('Error sending chat message:', error);
    throw error;
  }
}

// OneDrive Types
export interface DriveItem {
  id: string;
  name: string;
  folder?: { childCount: number };
  file?: { mimeType: string };
  size?: number;
  createdDateTime: string;
  lastModifiedDateTime: string;
  webUrl?: string;
  parentReference?: {
    id: string;
    path: string;
  };
}

// Get OneDrive root folder contents
export async function getOneDriveRoot(accessToken: string): Promise<DriveItem[]> {
  try {
    const client = getGraphClient(accessToken);
    const response = await client.api('/me/drive/root/children')
      .select('id,name,folder,file,size,createdDateTime,lastModifiedDateTime,webUrl,parentReference')
      .orderby('name')
      .get();
    return response.value;
  } catch (error) {
    console.error('Error fetching OneDrive root:', error);
    throw error;
  }
}

// Get folder contents by folder ID
export async function getOneDriveFolderContents(
  accessToken: string,
  folderId: string
): Promise<DriveItem[]> {
  try {
    const client = getGraphClient(accessToken);
    const response = await client.api(`/me/drive/items/${folderId}/children`)
      .select('id,name,folder,file,size,createdDateTime,lastModifiedDateTime,webUrl,parentReference')
      .orderby('name')
      .get();
    return response.value;
  } catch (error) {
    console.error('Error fetching folder contents:', error);
    throw error;
  }
}

// Get folder info by ID
export async function getOneDriveItem(
  accessToken: string,
  itemId: string
): Promise<DriveItem> {
  try {
    const client = getGraphClient(accessToken);
    const item = await client.api(`/me/drive/items/${itemId}`)
      .select('id,name,folder,file,size,createdDateTime,lastModifiedDateTime,webUrl,parentReference')
      .get();
    return item;
  } catch (error) {
    console.error('Error fetching item:', error);
    throw error;
  }
}

// Create a new folder
export async function createOneDriveFolder(
  accessToken: string,
  parentFolderId: string | null,
  folderName: string
): Promise<DriveItem> {
  try {
    const client = getGraphClient(accessToken);
    const endpoint = parentFolderId 
      ? `/me/drive/items/${parentFolderId}/children`
      : '/me/drive/root/children';
    
    const response = await client.api(endpoint)
      .post({
        name: folderName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename'
      });
    return response;
  } catch (error) {
    console.error('Error creating folder:', error);
    throw error;
  }
}

// Delete a file or folder
export async function deleteOneDriveItem(
  accessToken: string,
  itemId: string
): Promise<void> {
  try {
    const client = getGraphClient(accessToken);
    await client.api(`/me/drive/items/${itemId}`).delete();
  } catch (error) {
    console.error('Error deleting item:', error);
    throw error;
  }
}

// Rename a file or folder
export async function renameOneDriveItem(
  accessToken: string,
  itemId: string,
  newName: string
): Promise<DriveItem> {
  try {
    const client = getGraphClient(accessToken);
    const response = await client.api(`/me/drive/items/${itemId}`)
      .patch({ name: newName });
    return response;
  } catch (error) {
    console.error('Error renaming item:', error);
    throw error;
  }
}

// Upload a text file (for saving summaries)
export async function uploadTextFile(
  accessToken: string,
  parentFolderId: string | null,
  fileName: string,
  content: string
): Promise<DriveItem> {
  try {
    const client = getGraphClient(accessToken);
    const endpoint = parentFolderId
      ? `/me/drive/items/${parentFolderId}:/${fileName}:/content`
      : `/me/drive/root:/${fileName}:/content`;
    
    const response = await client.api(endpoint)
      .put(content);
    return response;
  } catch (error) {
    console.error('Error uploading file:', error);
    throw error;
  }
}

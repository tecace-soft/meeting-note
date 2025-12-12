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

function getGraphClient(accessToken: string): Client {
  return Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    },
  });
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

    console.log('First chat lastMessagePreview:', response.value[0]?.lastMessagePreview);

    const chats = response.value.map((chat: any) => {
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
    });

    // Sort by lastMessageDateTime if available, otherwise lastUpdatedDateTime
    return chats.sort((a: TeamsChat, b: TeamsChat) => {
      const dateA = a.lastMessageDateTime || a.lastUpdatedDateTime;
      const dateB = b.lastMessageDateTime || b.lastUpdatedDateTime;
      return new Date(dateB).getTime() - new Date(dateA).getTime();
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


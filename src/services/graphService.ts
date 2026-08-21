import { Client } from '@microsoft/microsoft-graph-client';

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

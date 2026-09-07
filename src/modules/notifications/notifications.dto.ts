export type NotificationData = {
  graphId?: string;
  scheduledForDeletionAt?: string;
  [key: string]: unknown;
};

export type NotificationResponse = {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  data: NotificationData | null;
  isRead: boolean;
  createdAt: string;
  updatedAt: string;
};

export type NotificationListResponse = {
  items: NotificationResponse[];
  unreadCount: number;
};

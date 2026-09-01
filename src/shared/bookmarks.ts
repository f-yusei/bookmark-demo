export type Bookmark = {
  id: number;
  url: string;
  title: string;
  tags: string;
  memo: string;
  ogpImageUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateBookmarkRequest = {
  url: string;
  tags?: string;
  memo?: string;
};

export type UpdateBookmarkRequest = {
  url: string;
  tags?: string;
  memo?: string;
};

export type ApiError = {
  error: string;
};

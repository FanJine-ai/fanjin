export interface AuthUser {
  isLoggedIn: boolean;
  userId: string;
  apiKey: string;
  phone: string;
  points: number;
  grains: number;
  nickname: string;
  signature?: string;
  avatarUrl?: string;
  inviteCode: string;
  inviteLink: string;
  loginTime: string;
}

export interface ApiEnvelope<T> {
  success: boolean;
  code?: number;
  data?: T;
  message?: string;
  error?: string;
  user?: unknown;
}

export interface Transaction {
  id?: string | number;
  type: string;
  points?: number;
  grains?: number;
  amount?: number;
  balanceAfter?: number;
  orderId?: string;
  detail?: string;
  message?: string;
  createdAt: string;
  status?: string;
  productName?: string;
  source?: string;
  effectiveAt?: string;
  expireAt?: string;
}

export interface OrderRecord {
  id: string;
  orderId: string;
  createdAt: string;
  productName: string;
  amount: number;
  points: number;
  status: string;
  actionText?: string;
}

export interface PowerRecord {
  id: string | number;
  createdAt: string;
  source: string;
  effectiveAt: string;
  expireAt: string;
  points: number;
  type?: string;
}

export interface InvitedUserRecord {
  userId: string;
  nickname: string;
  phoneMasked: string;
  registeredAt: string;
  rewardStatus: string;
}

export interface CanvasNode {
  id: string;
  x: number;
  y: number;
  type: "text" | "image" | "video" | "audio" | "script";
  title: string;
  width: number;
  height: number;
  prompt?: string;
  imageUrl?: string;
  videoUrl?: string;
  resultText?: string;
  selectedModelKey?: string;
  isGenerating?: boolean;
}

export interface CanvasConnection {
  id: string;
  fromNode: string;
  toNode: string;
}

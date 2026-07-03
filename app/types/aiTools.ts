export type AiToolStatus = 'active' | 'inactive';

export interface AiToolRecord {
  id: string;
  name: string;
  shortTitle: string;
  description: string;
  category: string;
  subcategory: string;
  iconUrl: string;
  websiteUrl?: string;
  displayOrder: number;
  status: AiToolStatus;
  featured: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface AiToolsSubcategoryGroup {
  name: string;
  tools: AiToolRecord[];
}

export interface AiToolsCategoryGroup {
  name: string;
  subcategories: AiToolsSubcategoryGroup[];
}

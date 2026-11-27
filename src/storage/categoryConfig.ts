import {noodleDb} from '../db/noodleDb';
import {
  CATEGORY_COLOR_PALETTE,
  CATEGORY_STYLE,
  CategoryColorKey,
  CategoryStyle,
  DEFAULT_CATEGORY_CONFIGS,
  UserCategoryConfig,
} from '../types/noodle';

const CATEGORY_CONFIG_SETTING_KEY = 'workspace.categoryConfig';
const MAX_LABEL_LEN = 48;

const VALID_COLOR_KEYS: CategoryColorKey[] = [
  'sky',
  'amber',
  'rose',
  'emerald',
  'violet',
  'teal',
  'orange',
  'slate',
];

export const CATEGORY_COLOR_OPTIONS: Array<{
  key: CategoryColorKey;
  label: string;
  dot: string;
}> = [
  {key: 'amber', label: 'Amber', dot: CATEGORY_COLOR_PALETTE.amber.dot},
  {key: 'sky', label: 'Sky', dot: CATEGORY_COLOR_PALETTE.sky.dot},
  {key: 'emerald', label: 'Emerald', dot: CATEGORY_COLOR_PALETTE.emerald.dot},
  {key: 'rose', label: 'Rose', dot: CATEGORY_COLOR_PALETTE.rose.dot},
  {key: 'violet', label: 'Violet', dot: CATEGORY_COLOR_PALETTE.violet.dot},
  {key: 'teal', label: 'Teal', dot: CATEGORY_COLOR_PALETTE.teal.dot},
  {key: 'orange', label: 'Orange', dot: CATEGORY_COLOR_PALETTE.orange.dot},
  {key: 'slate', label: 'Slate', dot: CATEGORY_COLOR_PALETTE.slate.dot},
];

export function sanitizeCategoryLabel(raw: string): string {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw
    .replace(/[\u0000-\u001f\u007f/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_LEN);
}

export function getDefaultCategoryConfigs(): UserCategoryConfig[] {
  return DEFAULT_CATEGORY_CONFIGS.map((item) => ({
    ...item,
    subfolders: [...item.subfolders],
  }));
}

function makeCategoryId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const rand = Math.random().toString(36).slice(2, 7);
  return `cat-${slug || 'custom'}-${rand}`;
}

function pickFallbackColor(name: string): CategoryColorKey {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return VALID_COLOR_KEYS[hash % VALID_COLOR_KEYS.length];
}

export function normalizeCategoryConfigs(raw: unknown): UserCategoryConfig[] {
  if (!Array.isArray(raw)) {
    return getDefaultCategoryConfigs();
  }

  const seenNames = new Set<string>();
  const out: UserCategoryConfig[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const name = sanitizeCategoryLabel(String(obj.name ?? ''));
    if (!name) {
      continue;
    }
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) {
      continue;
    }
    seenNames.add(nameKey);

    const rawColor = obj.color as CategoryColorKey;
    const color: CategoryColorKey = VALID_COLOR_KEYS.includes(rawColor)
      ? rawColor
      : pickFallbackColor(name);

    const seenSubs = new Set<string>();
    const subfolders: string[] = [];
    if (Array.isArray(obj.subfolders)) {
      for (const rawSub of obj.subfolders) {
        const cleanSub = sanitizeCategoryLabel(String(rawSub ?? ''));
        if (!cleanSub) {
          continue;
        }
        const subKey = cleanSub.toLowerCase();
        if (!seenSubs.has(subKey)) {
          seenSubs.add(subKey);
          subfolders.push(cleanSub);
        }
      }
    }

    const id =
      typeof obj.id === 'string' && obj.id.trim()
        ? obj.id.trim()
        : makeCategoryId(name);

    out.push({
      id,
      name,
      color,
      subfolders,
    });
  }

  return out.length > 0 ? out : getDefaultCategoryConfigs();
}

export function getCategoryStyle(
  categoryName: string,
  configs?: UserCategoryConfig[],
): CategoryStyle {
  const clean = sanitizeCategoryLabel(categoryName);
  if (configs && clean) {
    const match = configs.find(
      (c) => c.name.toLowerCase() === clean.toLowerCase(),
    );
    if (match && CATEGORY_COLOR_PALETTE[match.color]) {
      return CATEGORY_COLOR_PALETTE[match.color];
    }
  }
  if (CATEGORY_STYLE[clean]) {
    return CATEGORY_STYLE[clean];
  }
  return CATEGORY_COLOR_PALETTE[pickFallbackColor(clean || 'Study')];
}

export function getSubfoldersForCategory(
  configs: UserCategoryConfig[],
  categoryName: string,
): string[] {
  const match = configs.find(
    (c) => c.name.toLowerCase() === categoryName.trim().toLowerCase(),
  );
  return match ? match.subfolders : [];
}

export function addTopCategory(
  configs: UserCategoryConfig[],
  rawName: string,
  color?: CategoryColorKey,
): {configs: UserCategoryConfig[]; created?: UserCategoryConfig; error?: string} {
  const name = sanitizeCategoryLabel(rawName);
  if (!name) {
    return {configs, error: 'Category name cannot be empty.'};
  }
  if (configs.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    return {configs, error: `"${name}" already exists.`};
  }
  const chosenColor = color ?? VALID_COLOR_KEYS[configs.length % VALID_COLOR_KEYS.length];
  const created: UserCategoryConfig = {
    id: makeCategoryId(name),
    name,
    color: chosenColor,
    subfolders: [],
  };
  return {
    configs: [...configs, created],
    created,
  };
}

export function renameTopCategory(
  configs: UserCategoryConfig[],
  categoryId: string,
  rawNewName: string,
): {
  configs: UserCategoryConfig[];
  oldName?: string;
  newName?: string;
  error?: string;
} {
  const target = configs.find((c) => c.id === categoryId);
  if (!target) {
    return {configs, error: 'Category not found.'};
  }
  const newName = sanitizeCategoryLabel(rawNewName);
  if (!newName) {
    return {configs, error: 'Category name cannot be empty.'};
  }
  const conflict = configs.some(
    (c) =>
      c.id !== categoryId && c.name.toLowerCase() === newName.toLowerCase(),
  );
  if (conflict) {
    return {configs, error: `Another category is already named "${newName}".`};
  }
  const oldName = target.name;
  return {
    configs: configs.map((c) =>
      c.id === categoryId ? {...c, name: newName} : c,
    ),
    oldName,
    newName,
  };
}

export function updateTopCategoryColor(
  configs: UserCategoryConfig[],
  categoryId: string,
  color: CategoryColorKey,
): UserCategoryConfig[] {
  return configs.map((c) => (c.id === categoryId ? {...c, color} : c));
}

export function deleteTopCategory(
  configs: UserCategoryConfig[],
  categoryId: string,
): {
  configs: UserCategoryConfig[];
  deletedName?: string;
  fallbackName?: string;
  error?: string;
} {
  if (configs.length <= 1) {
    return {configs, error: 'Keep at least one category.'};
  }
  const target = configs.find((c) => c.id === categoryId);
  if (!target) {
    return {configs, error: 'Category not found.'};
  }
  const remaining = configs.filter((c) => c.id !== categoryId);
  return {
    configs: remaining,
    deletedName: target.name,
    fallbackName: remaining[0].name,
  };
}

export function addSubfolderToCategory(
  configs: UserCategoryConfig[],
  categoryId: string,
  rawSubfolder: string,
): {
  configs: UserCategoryConfig[];
  addedName?: string;
  error?: string;
} {
  const target = configs.find((c) => c.id === categoryId);
  if (!target) {
    return {configs, error: 'Category not found.'};
  }
  const cleanSub = sanitizeCategoryLabel(rawSubfolder);
  if (!cleanSub) {
    return {configs, error: 'Subfolder name cannot be empty.'};
  }
  if (
    target.subfolders.some(
      (s) => s.toLowerCase() === cleanSub.toLowerCase(),
    )
  ) {
    return {
      configs,
      error: `Subfolder "${cleanSub}" already exists in ${target.name}.`,
    };
  }
  return {
    configs: configs.map((c) =>
      c.id === categoryId
        ? {...c, subfolders: [...c.subfolders, cleanSub]}
        : c,
    ),
    addedName: cleanSub,
  };
}

export function renameSubfolderInCategory(
  configs: UserCategoryConfig[],
  categoryId: string,
  oldSubfolder: string,
  rawNewSubfolder: string,
): {
  configs: UserCategoryConfig[];
  categoryName?: string;
  oldName?: string;
  newName?: string;
  error?: string;
} {
  const target = configs.find((c) => c.id === categoryId);
  if (!target) {
    return {configs, error: 'Category not found.'};
  }
  const newName = sanitizeCategoryLabel(rawNewSubfolder);
  if (!newName) {
    return {configs, error: 'Subfolder name cannot be empty.'};
  }
  const conflict = target.subfolders.some(
    (s) =>
      s.toLowerCase() !== oldSubfolder.toLowerCase() &&
      s.toLowerCase() === newName.toLowerCase(),
  );
  if (conflict) {
    return {
      configs,
      error: `Subfolder "${newName}" already exists in ${target.name}.`,
    };
  }
  return {
    configs: configs.map((c) =>
      c.id === categoryId
        ? {
            ...c,
            subfolders: c.subfolders.map((s) =>
              s === oldSubfolder ? newName : s,
            ),
          }
        : c,
    ),
    categoryName: target.name,
    oldName: oldSubfolder,
    newName,
  };
}

export function deleteSubfolderInCategory(
  configs: UserCategoryConfig[],
  categoryId: string,
  subfolderName: string,
): {
  configs: UserCategoryConfig[];
  categoryName?: string;
  deletedSubfolder?: string;
} {
  const target = configs.find((c) => c.id === categoryId);
  if (!target) {
    return {configs};
  }
  return {
    configs: configs.map((c) =>
      c.id === categoryId
        ? {
            ...c,
            subfolders: c.subfolders.filter((s) => s !== subfolderName),
          }
        : c,
    ),
    categoryName: target.name,
    deletedSubfolder: subfolderName,
  };
}

/**
 * Ensures any category/subfolder already present on disk notes appears in the user's config
 * cleanly if it doesn't collide with deleted/renamed ones when first discovering notes.
 */
export function mergeDiscoveredNoteCategories(
  configs: UserCategoryConfig[],
  notes: Array<{category: string; subfolder?: string}>,
): UserCategoryConfig[] {
  let next = configs.map((c) => ({...c, subfolders: [...c.subfolders]}));
  let changed = false;

  for (const n of notes) {
    const cleanCat = sanitizeCategoryLabel(n.category);
    if (!cleanCat) continue;
    let existingCat = next.find(
      (c) => c.name.toLowerCase() === cleanCat.toLowerCase(),
    );
    if (!existingCat) {
      existingCat = {
        id: makeCategoryId(cleanCat),
        name: cleanCat,
        color: pickFallbackColor(cleanCat),
        subfolders: [],
      };
      next = [...next, existingCat];
      changed = true;
    }
    const cleanSub = n.subfolder ? sanitizeCategoryLabel(n.subfolder) : '';
    if (
      cleanSub &&
      !existingCat.subfolders.some(
        (s) => s.toLowerCase() === cleanSub.toLowerCase(),
      )
    ) {
      existingCat.subfolders = [...existingCat.subfolders, cleanSub];
      changed = true;
    }
  }

  return changed ? next : configs;
}

export async function loadCategoryConfigs(): Promise<UserCategoryConfig[]> {
  try {
    const row = await noodleDb.appSettings.get(CATEGORY_CONFIG_SETTING_KEY);
    if (row && typeof row.value === 'string') {
      const parsed = JSON.parse(row.value) as unknown;
      return normalizeCategoryConfigs(parsed);
    }
  } catch {
    // Fallback cleanly to defaults
  }
  return getDefaultCategoryConfigs();
}

export async function saveCategoryConfigs(
  configs: UserCategoryConfig[],
): Promise<UserCategoryConfig[]> {
  const normalized = normalizeCategoryConfigs(configs);
  await noodleDb.appSettings.put({
    key: CATEGORY_CONFIG_SETTING_KEY,
    value: JSON.stringify(normalized),
  });
  return normalized;
}

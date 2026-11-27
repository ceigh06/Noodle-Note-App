import {useCallback, useEffect, useRef, useState} from 'react';
import {
  EditorContent,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from '@tiptap/extension-table';
import UniqueID from '@tiptap/extension-unique-id';
import {
  ArrowLeft,
  Bold,
  Check,
  CheckSquare,
  ChevronRight,
  Code2,
  Download,
  FileText,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  Lock,
  Minus,
  Plus,
  Quote,
  Redo2,
  RemoveFormatting,
  SlidersHorizontal,
  Sparkles,
  Strikethrough,
  Table as TableIcon,
  Trash2,
  Underline as UnderlineIcon,
  Undo2,
} from 'lucide-react';
import {tiptapToMarkdown} from '../editor/markdownCodec';
import {
  BLOCK_NODE_TYPES,
  canonicalStringify,
  createUuid,
  deriveFirstLineTitle,
  ensureBlockIds,
  isAllowedLinkUrl,
  MAX_IMAGE_BYTES,
  shouldScheduleAutosave,
} from '../editor/noteSchema';
import {
  getCategoryStyle,
  getDefaultCategoryConfigs,
  getSubfoldersForCategory,
  sanitizeCategoryLabel,
} from '../storage/categoryConfig';
import {
  importImageAsset,
  previewOrphanAssetsForNoteDelete,
} from '../storage/workspaceStorage';
import {
  BacklinkRecord,
  Category,
  ExternalEditConflict,
  StoredNoteEntry,
  SuggestedConnection,
  TipTapDoc,
  UserCategoryConfig,
} from '../types/noodle';
import {
  AiProvenanceBanner,
  FlashcardDeckView,
  PracticeExamView,
} from './AiInteractiveViews';
import {ConnectionsPanel} from './ConnectionsPanel';
import {WorkspaceImageNodeView} from './WorkspaceImageNodeView';

const MAX_IMAGE_MB = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));

const WorkspaceImage = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(WorkspaceImageNodeView);
  },
}).configure({
  allowBase64: false,
  inline: false,
});

interface NoteEditorViewProps {
  entry: StoredNoteEntry;
  allNotes?: StoredNoteEntry[];
  categoryConfigs?: UserCategoryConfig[];
  targetBlockId?: string | null;
  reloadVersion?: number;
  externalConflict?: ExternalEditConflict | null;
  aiChatOpen?: boolean;
  onToggleAiChat?: () => void;
  backlinks?: BacklinkRecord[];
  suggestions?: SuggestedConnection[];
  suggestionMode?: 'semantic' | 'word-match';
  suggestionsLoading?: boolean;
  onReloadExternal?: () => void;
  onKeepMineExternal?: () => void;
  onLinkSuggestion?: (
    suggestion: SuggestedConnection,
    sourceBlockId: string,
  ) => void;
  onDismissSuggestion?: (suggestion: SuggestedConnection) => void;
  onRemoveBacklink?: (backlinkId: string) => void;
  onNavigateToBlock?: (
    noteId: string,
    blockId: string,
    kind: 'note' | 'source',
  ) => void;
  onSelectNote?: (entry: StoredNoteEntry) => void;
  onCreateNoteInFolder?: (category: Category, subfolder?: string) => void;
  onOpenCategoryManager?: () => void;
  onQuickAddSubfolder?: (categoryName: string, subfolderName: string) => Promise<void> | void;
  onBack: () => void;
  onSaveNote: (
    entry: StoredNoteEntry,
    patch: {
      title: string;
      category: Category;
      subfolder?: string | null;
      content: TipTapDoc;
    },
  ) => Promise<StoredNoteEntry>;
  onDeleteNote: (
    entry: StoredNoteEntry,
    orphanAssetsToDelete: string[],
  ) => Promise<void>;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function NoteEditorView({
  entry,
  allNotes = [],
  categoryConfigs: providedCategoryConfigs,
  targetBlockId = null,
  reloadVersion = 0,
  externalConflict = null,
  aiChatOpen = false,
  onToggleAiChat,
  backlinks = [],
  suggestions = [],
  suggestionMode = 'word-match',
  suggestionsLoading = false,
  onReloadExternal,
  onKeepMineExternal,
  onLinkSuggestion,
  onDismissSuggestion,
  onRemoveBacklink,
  onNavigateToBlock,
  onSelectNote,
  onCreateNoteInFolder,
  onOpenCategoryManager,
  onQuickAddSubfolder,
  onBack,
  onSaveNote,
  onDeleteNote,
}: NoteEditorViewProps) {
  const categoryConfigs = providedCategoryConfigs ?? getDefaultCategoryConfigs();
  const isImmutable = entry.pillar === 'sources';
  const editable = !isImmutable;

  const [title, setTitle] = useState(entry.note.title);
  const [category, setCategory] = useState<Category>(entry.note.category);
  const [subfolder, setSubfolder] = useState<string>(entry.note.subfolder ?? '');
  const [folderPanelOpen, setFolderPanelOpen] = useState(true);
  const [browseCategory, setBrowseCategory] = useState<string | null>(
    entry.note.category || null,
  );
  const [browseSubfolder, setBrowseSubfolder] = useState<string | null>(
    entry.note.subfolder || null,
  );
  const [addingSubfolder, setAddingSubfolder] = useState(false);
  const [newSubDraft, setNewSubDraft] = useState('');
  const [movedNotice, setMovedNotice] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [orphanAssetsToDelete, setOrphanAssetsToDelete] = useState<string[]>(
    [],
  );
  const [needsFirstAssetConfirm, setNeedsFirstAssetConfirm] = useState(false);
  const [loadingOrphanPreview, setLoadingOrphanPreview] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [aiInteractiveTab, setAiInteractiveTab] = useState<'interactive' | 'document'>(
    entry.note.aiMeta?.flashcards?.length ||
      entry.note.aiMeta?.examQuestions?.length
      ? 'interactive'
      : 'document',
  );

  // Link popover state
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linkUrlInput, setLinkUrlInput] = useState('');
  const [linkUrlError, setLinkUrlError] = useState<string | null>(null);

  // Refs for autosave & no-autosave-on-open guard
  const entryRef = useRef(entry);
  const titleRef = useRef(entry.note.title);
  const categoryRef = useRef<Category>(entry.note.category);
  const subfolderRef = useRef<string>(entry.note.subfolder ?? '');
  const titleManualRef = useRef(
    entry.note.title.trim() !== '' && entry.note.title !== 'Untitled Note',
  );
  const isHydratingRef = useRef(true);
  const lastSavedCanonicalRef = useRef(canonicalStringify(entry.note.content));
  const debounceTimerRef = useRef<number | null>(null);
  const movedTimerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const latestDocRef = useRef<TipTapDoc>(entry.note.content);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const proseContainerRef = useRef<HTMLDivElement | null>(null);
  const externalConflictRef = useRef<ExternalEditConflict | null>(externalConflict);
  const handleInsertImagesRef = useRef<
    (files: File[], insertPos?: number) => Promise<void>
  >(async () => {});

  useEffect(() => {
    entryRef.current = entry;
  }, [entry]);

  const clearPendingTimer = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    externalConflictRef.current = externalConflict;
    if (externalConflict) {
      clearPendingTimer();
    }
  }, [clearPendingTimer, externalConflict]);

  const performSave = useCallback(
    async (
      nextTitle: string,
      nextCategory: Category,
      nextSubfolder: string,
      nextContent: TipTapDoc,
    ) => {
      if (isImmutable) {
        return;
      }
      setSaveStatus('saving');
      setSaveError(null);
      try {
        const sanitizedDoc = ensureBlockIds(nextContent);
        const cleanSub = sanitizeCategoryLabel(nextSubfolder);
        const saved = await onSaveNote(entryRef.current, {
          title: nextTitle.trim() || 'Untitled Note',
          category: nextCategory,
          subfolder: cleanSub || null,
          content: sanitizedDoc,
        });
        entryRef.current = saved;
        lastSavedCanonicalRef.current = canonicalStringify(saved.note.content);
        dirtyRef.current = false;
        setSaveStatus('saved');
      } catch (err) {
        setSaveError((err as Error).message || 'Failed to save note.');
        setSaveStatus('error');
      }
    },
    [isImmutable, onSaveNote],
  );

  const scheduleDebouncedSave = useCallback(
    (nextContent: TipTapDoc) => {
      if (isImmutable) {
        return;
      }
      clearPendingTimer();
      dirtyRef.current = true;
      if (externalConflictRef.current) {
        // Never overwrite an external edit until the user picks Reload or Keep mine
        return;
      }
      setSaveStatus('saving');
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        if (externalConflictRef.current) {
          return;
        }
        void performSave(
          titleRef.current,
          categoryRef.current,
          subfolderRef.current,
          nextContent,
        );
      }, 1000);
    },
    [clearPendingTimer, isImmutable, performSave],
  );

  const editor = useEditor(
    {
      editable,
      extensions: [
        StarterKit.configure({
          link: false,
          underline: false,
          heading: {levels: [1, 2, 3]},
        }),
        Underline,
        Link.configure({
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: 'https',
          protocols: ['http', 'https', 'mailto'],
          HTMLAttributes: {
            rel: 'noopener noreferrer',
            target: '_blank',
          },
          isAllowedUri: (url) => isAllowedLinkUrl(url),
        }),
        TaskList,
        TaskItem.configure({
          nested: true,
        }),
        Table.configure({
          resizable: false,
        }),
        TableRow,
        TableHeader,
        TableCell,
        WorkspaceImage,
        UniqueID.configure({
          attributeName: 'id',
          types: BLOCK_NODE_TYPES,
          generateID: () => createUuid(),
        }),
      ],
      editorProps: {
        handleDrop: (view, event, _slice, moved) => {
          if (!editable || moved) {
            return false;
          }
          const files = Array.from(event.dataTransfer?.files ?? []);
          const imageFiles = files.filter(
            (f) =>
              f.type.startsWith('image/') ||
              /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name),
          );
          if (imageFiles.length === 0) {
            return false;
          }
          event.preventDefault();
          const coords = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          void handleInsertImagesRef.current(imageFiles, coords?.pos);
          return true;
        },
        handlePaste: (_view, event) => {
          if (!editable) {
            return false;
          }
          const files = Array.from(event.clipboardData?.files ?? []);
          const imageFiles = files.filter(
            (f) =>
              f.type.startsWith('image/') ||
              /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name),
          );
          if (imageFiles.length === 0) {
            return false;
          }
          event.preventDefault();
          void handleInsertImagesRef.current(imageFiles);
          return true;
        },
      },
      content: entry.note.content,
      onCreate: () => {
        // Hydrate complete; clear flag on next microtask so initial UniqueID pass never triggers autosave
        queueMicrotask(() => {
          isHydratingRef.current = false;
        });
      },
      onUpdate: ({editor: ed, transaction}) => {
        const nextDoc = ed.getJSON() as TipTapDoc;
        latestDocRef.current = nextDoc;
        const nextCanonical = canonicalStringify(nextDoc);
        const isUniqueIdInit = Boolean(
          transaction.getMeta('__uniqueIDTransaction'),
        );

        if (
          !shouldScheduleAutosave({
            editable,
            isHydrating: isHydratingRef.current,
            docChanged: transaction.docChanged,
            isUniqueIdInit,
            currentCanonical: nextCanonical,
            lastSavedCanonical: lastSavedCanonicalRef.current,
          })
        ) {
          return;
        }

        // First-line auto-titling when user hasn't manually set a title
        if (!titleManualRef.current) {
          const derived = deriveFirstLineTitle(nextDoc);
          if (derived && derived !== titleRef.current) {
            titleRef.current = derived;
            setTitle(derived);
          }
        }

        scheduleDebouncedSave(nextDoc);
      },
    },
    [entry.note.id],
  );

  // Reset state cleanly if switching between notes or reloading external disk changes
  useEffect(() => {
    clearPendingTimer();
    isHydratingRef.current = true;
    dirtyRef.current = false;
    titleRef.current = entry.note.title;
    categoryRef.current = entry.note.category;
    subfolderRef.current = entry.note.subfolder ?? '';
    latestDocRef.current = entry.note.content;
    titleManualRef.current =
      entry.note.title.trim() !== '' && entry.note.title !== 'Untitled Note';
    lastSavedCanonicalRef.current = canonicalStringify(entry.note.content);
    setTitle(entry.note.title);
    setCategory(entry.note.category);
    setSubfolder(entry.note.subfolder ?? '');
    setBrowseCategory(entry.note.category || null);
    setBrowseSubfolder(entry.note.subfolder || null);
    setAddingSubfolder(false);
    setNewSubDraft('');
    setMovedNotice(null);
    setSaveStatus('idle');
    setSaveError(null);
    setImageError(null);
    setConfirmDelete(false);
    setOrphanAssetsToDelete([]);
    setNeedsFirstAssetConfirm(false);
    setAiInteractiveTab(
      !targetBlockId &&
        (entry.note.aiMeta?.flashcards?.length ||
          entry.note.aiMeta?.examQuestions?.length)
        ? 'interactive'
        : 'document',
    );

    if (editor && !editor.isDestroyed) {
      editor.setEditable(editable);
      editor.commands.setContent(entry.note.content, {emitUpdate: false});
      queueMicrotask(() => {
        isHydratingRef.current = false;
      });
    }
  }, [clearPendingTimer, editable, editor, entry.note.id, reloadVersion]);

  // Scroll cleanly to & highlight an exact blockId when opened from search or backlinks
  useEffect(() => {
    if (!targetBlockId) {
      return;
    }
    setAiInteractiveTab('document');
    if (!editor || editor.isDestroyed) {
      return;
    }
    let timer: number | null = null;
    const raf = window.requestAnimationFrame(() => {
      const container = proseContainerRef.current;
      if (!container) {
        return;
      }
      const selector = `[data-id="${CSS.escape(targetBlockId)}"]`;
      const el = container.querySelector(selector);
      if (el) {
        el.scrollIntoView({behavior: 'smooth', block: 'center'});
        el.classList.add('noodle-target-block');
        timer = window.setTimeout(() => {
          el.classList.remove('noodle-target-block');
        }, 2400);
      }
    });
    return () => {
      window.cancelAnimationFrame(raf);
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [editor, entry.note.id, targetBlockId]);

  const resolveActiveBlockId = useCallback((): string => {
    if (editor && !editor.isDestroyed) {
      const {$from} = editor.state.selection;
      for (let d = $from.depth; d > 0; d -= 1) {
        const idAttr = $from.node(d).attrs?.id;
        if (typeof idAttr === 'string' && idAttr.trim()) {
          return idAttr;
        }
      }
    }
    const firstBlock = entry.note.content.content?.[0];
    if (firstBlock?.attrs && typeof firstBlock.attrs.id === 'string') {
      return firstBlock.attrs.id;
    }
    return entry.note.id;
  }, [editor, entry.note.content.content, entry.note.id]);

  const handleInsertImages = useCallback(
    async (files: File[], insertPos?: number) => {
      if (isImmutable || !editor || files.length === 0) {
        return;
      }
      setImageError(null);
      setUploadingImage(true);
      try {
        let nextPos = insertPos;
        for (const file of files) {
          const imported = await importImageAsset(file);
          const chain = editor.chain().focus();
          if (typeof nextPos === 'number') {
            chain.setTextSelection(nextPos);
            nextPos = undefined;
          }
          chain
            .setImage({
              src: imported.assetPath,
              alt: file.name || 'Workspace image',
            })
            .run();
        }
      } catch (err) {
        setImageError(
          (err as Error).message ||
            `Failed to import image (allowed: PNG, JPG, JPEG, GIF, WebP up to ${MAX_IMAGE_MB} MB).`,
        );
      } finally {
        setUploadingImage(false);
      }
    },
    [editor, isImmutable],
  );

  useEffect(() => {
    handleInsertImagesRef.current = handleInsertImages;
  }, [handleInsertImages]);

  // Flush pending edits/moves on unmount so sidebar navigation never drops changes
  useEffect(() => {
    return () => {
      clearPendingTimer();
      if (movedTimerRef.current !== null) {
        window.clearTimeout(movedTimerRef.current);
        movedTimerRef.current = null;
      }
      if (dirtyRef.current && !isImmutable && !externalConflictRef.current) {
        dirtyRef.current = false;
        const sanitizedDoc = ensureBlockIds(latestDocRef.current);
        const cleanSub = sanitizeCategoryLabel(subfolderRef.current);
        void onSaveNote(entryRef.current, {
          title: titleRef.current.trim() || 'Untitled Note',
          category: categoryRef.current,
          subfolder: cleanSub || null,
          content: sanitizedDoc,
        });
      }
    };
  }, [clearPendingTimer, isImmutable, onSaveNote]);

  const toolbarState = useEditorState({
    editor,
    selector: (ctx) => {
      const ed = ctx.editor;
      if (!ed) {
        return null;
      }
      return {
        canUndo: ed.can().undo(),
        canRedo: ed.can().redo(),
        headingLevel: ed.isActive('heading', {level: 1})
          ? '1'
          : ed.isActive('heading', {level: 2})
            ? '2'
            : ed.isActive('heading', {level: 3})
              ? '3'
              : '0',
        isBold: ed.isActive('bold'),
        isItalic: ed.isActive('italic'),
        isUnderline: ed.isActive('underline'),
        isStrike: ed.isActive('strike'),
        isBulletList: ed.isActive('bulletList'),
        isOrderedList: ed.isActive('orderedList'),
        isTaskList: ed.isActive('taskList'),
        isBlockquote: ed.isActive('blockquote'),
        isCodeBlock: ed.isActive('codeBlock'),
        isLink: ed.isActive('link'),
        isTable: ed.isActive('table'),
      };
    },
  });

  const handleBack = async () => {
    if (dirtyRef.current && editor && !isImmutable) {
      clearPendingTimer();
      await performSave(
        titleRef.current,
        categoryRef.current,
        subfolderRef.current,
        editor.getJSON() as TipTapDoc,
      );
    }
    onBack();
  };

  const handleTitleChange = (nextTitle: string) => {
    if (isImmutable) {
      return;
    }
    titleManualRef.current = nextTitle.trim().length > 0;
    titleRef.current = nextTitle;
    setTitle(nextTitle);
    if (editor) {
      scheduleDebouncedSave(editor.getJSON() as TipTapDoc);
    }
  };

  const showMoveConfirmation = (label: string) => {
    setMovedNotice(label);
    if (movedTimerRef.current !== null) {
      window.clearTimeout(movedTimerRef.current);
    }
    movedTimerRef.current = window.setTimeout(() => {
      movedTimerRef.current = null;
      setMovedNotice(null);
    }, 2400);
  };

  const moveOpenNoteTo = (nextCategory: Category, nextSubfolder: string) => {
    if (isImmutable) {
      return;
    }
    categoryRef.current = nextCategory;
    setCategory(nextCategory);
    subfolderRef.current = nextSubfolder;
    setSubfolder(nextSubfolder);
    showMoveConfirmation(
      nextSubfolder
        ? `Moved to ${nextCategory} / ${nextSubfolder}`
        : `Moved to ${nextCategory}`,
    );
    const doc = (editor?.getJSON() as TipTapDoc | undefined) ?? latestDocRef.current;
    latestDocRef.current = doc;
    clearPendingTimer();
    if (!externalConflictRef.current) {
      void performSave(titleRef.current, nextCategory, nextSubfolder, doc);
    } else {
      dirtyRef.current = true;
    }
  };

  const handleOpenNoteFromPanel = async (target: StoredNoteEntry) => {
    if (target.note.id === entry.note.id || !onSelectNote) {
      return;
    }
    if (dirtyRef.current && editor && !isImmutable) {
      clearPendingTimer();
      await performSave(
        titleRef.current,
        categoryRef.current,
        subfolderRef.current,
        editor.getJSON() as TipTapDoc,
      );
    }
    onSelectNote(target);
  };

  const handleCreateSubfolderInBrowser = async () => {
    const clean = sanitizeCategoryLabel(newSubDraft);
    const targetCat = browseCategory;
    if (!clean || !targetCat) {
      setAddingSubfolder(false);
      setNewSubDraft('');
      return;
    }
    if (onQuickAddSubfolder) {
      await onQuickAddSubfolder(targetCat, clean);
    }
    setBrowseSubfolder(clean);
    setAddingSubfolder(false);
    setNewSubDraft('');
  };

  // Safe link click handling: never navigates the app, opens valid http/https/mailto in new tab with rel="noopener noreferrer"
  const handleProseClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    const anchor = target?.closest('a');
    if (!anchor) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const href = anchor.getAttribute('href') ?? '';
    if (!isAllowedLinkUrl(href)) {
      return;
    }

    const synthetic = document.createElement('a');
    synthetic.href = href;
    synthetic.target = '_blank';
    synthetic.rel = 'noopener noreferrer';
    synthetic.click();
  };

  const handleOpenLinkDialog = () => {
    if (!editor) {
      return;
    }
    const existingHref =
      (editor.getAttributes('link')?.href as string | undefined) ?? '';
    setLinkUrlInput(existingHref);
    setLinkUrlError(null);
    setLinkModalOpen(true);
  };

  const handleApplyLink = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editor) {
      return;
    }
    const trimmed = linkUrlInput.trim();
    if (!trimmed) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      setLinkModalOpen(false);
      return;
    }
    if (!isAllowedLinkUrl(trimmed)) {
      setLinkUrlError('Only http://, https://, and mailto: URLs are allowed.');
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange('link')
      .setLink({
        href: trimmed,
        target: '_blank',
        rel: 'noopener noreferrer',
      })
      .run();
    setLinkModalOpen(false);
  };

  const handleExportMarkdown = () => {
    if (!editor) {
      return;
    }
    const md = tiptapToMarkdown(editor.getJSON() as TipTapDoc);
    const blob = new Blob([md], {type: 'text/markdown;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const slug = (titleRef.current || 'note')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug || 'note'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleOpenDeleteConfirm = async () => {
    if (isImmutable) {
      return;
    }
    setConfirmDelete(true);
    setLoadingOrphanPreview(true);
    try {
      const currentDoc =
        (editor?.getJSON() as TipTapDoc | undefined) ?? entryRef.current.note.content;
      const preview = await previewOrphanAssetsForNoteDelete(
        entryRef.current.note.id,
        currentDoc,
      );
      setOrphanAssetsToDelete(preview.orphanAssets);
      setNeedsFirstAssetConfirm(preview.needsFirstConfirmation);
    } catch {
      setOrphanAssetsToDelete([]);
      setNeedsFirstAssetConfirm(false);
    } finally {
      setLoadingOrphanPreview(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (isImmutable || deleting) {
      return;
    }
    clearPendingTimer();
    setDeleting(true);
    try {
      await onDeleteNote(entryRef.current, orphanAssetsToDelete);
    } catch (err) {
      setSaveError((err as Error).message || 'Could not delete note.');
      setDeleting(false);
    }
  };

  const pillarLabel =
    entry.pillar === 'sources'
      ? 'Sources (read-only)'
      : entry.pillar === 'manual'
        ? 'My Notes'
        : 'AI Notes';

  const browsedSubfolders = browseCategory
    ? getSubfoldersForCategory(categoryConfigs, browseCategory)
    : [];
  const browsedDirectNotes = browseCategory
    ? allNotes.filter(
        (n) =>
          n.note.category.toLowerCase() === browseCategory.toLowerCase() &&
          !(n.note.subfolder ?? '').trim(),
      )
    : [];
  const browsedSubfolderNotes =
    browseCategory && browseSubfolder
      ? allNotes.filter(
          (n) =>
            n.note.category.toLowerCase() === browseCategory.toLowerCase() &&
            (n.note.subfolder ?? '').toLowerCase() ===
              browseSubfolder.toLowerCase(),
        )
      : [];
  const isViewingDifferentFolder =
    browseCategory !== null &&
    (category.toLowerCase() !== browseCategory.toLowerCase() ||
      (subfolder || '').toLowerCase() !== (browseSubfolder || '').toLowerCase());

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0C0D10]">
      {/* Fixed Top Editor Header & Google Docs-Style Toolbar */}
      <div className="shrink-0 border-b border-[#232734] bg-[#12141A]">
        {/* Row 1: Back, Meta, Save Status, Folders Toggle, AI Chat, Export MD, Delete */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1E222E] px-4 py-2.5 lg:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleBack}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#272C3A] bg-[#171A22] px-2.5 py-1.5 text-xs font-medium text-[#C8CCD6] transition-colors hover:border-[#3A4154] hover:text-[#F4F0E7]"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Notes</span>
            </button>

            <div className="hidden items-center gap-2 text-xs text-[#888F9F] sm:flex">
              <span>{pillarLabel}</span>
              <span aria-hidden="true">·</span>
              <span className="text-[#C8CCD6]">
                {subfolder ? `${category} / ${subfolder}` : category}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            {/* Save indicator */}
            {isImmutable ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-[#9CA1AE]">
                <Lock className="h-3.5 w-3.5 text-[#E0A83E]" />
                <span>Read-only</span>
              </span>
            ) : (
              <span
                aria-live="polite"
                className={`inline-flex items-center gap-1.5 text-xs tabular-nums ${
                  saveStatus === 'error'
                    ? 'text-rose-400'
                    : saveStatus === 'saving'
                      ? 'text-[#E0A83E]'
                      : saveStatus === 'saved'
                        ? 'text-emerald-400'
                        : 'text-[#7D8496]'
                }`}
              >
                {saveStatus === 'saved' && <Check className="h-3.5 w-3.5" />}
                <span>
                  {saveStatus === 'saving'
                    ? 'Saving...'
                    : saveStatus === 'saved'
                      ? 'Saved'
                      : saveStatus === 'error'
                        ? 'Save failed'
                        : 'Ready'}
                </span>
              </span>
            )}

            <button
              type="button"
              onClick={() => setFolderPanelOpen((prev) => !prev)}
              aria-pressed={folderPanelOpen}
              title="Toggle Folders Panel"
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
                folderPanelOpen
                  ? 'border-[#E0A83E] bg-[#1D2230] text-[#F3CA77]'
                  : 'border-[#272C3A] bg-[#171A22] text-[#C8CCD6] hover:border-[#3A4154] hover:text-[#F4F0E7]'
              }`}
            >
              <Folder className="h-3.5 w-3.5 text-[#E0A83E]" />
              <span className="hidden sm:inline">Folders</span>
            </button>

            {onToggleAiChat && (
              <button
                type="button"
                onClick={onToggleAiChat}
                aria-pressed={aiChatOpen}
                title="Toggle AI Note Chat Panel"
                className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
                  aiChatOpen
                    ? 'border-[#E0A83E] bg-[#1D2230] text-[#F3CA77]'
                    : 'border-[#272C3A] bg-[#171A22] text-[#C8CCD6] hover:border-[#3A4154] hover:text-[#F4F0E7]'
                }`}
              >
                <Sparkles className="h-3.5 w-3.5 text-[#E0A83E]" />
                <span className="hidden sm:inline">AI Chat</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleExportMarkdown}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#272C3A] bg-[#171A22] px-2.5 text-xs font-medium text-[#C8CCD6] transition-colors hover:border-[#3A4154] hover:text-[#F4F0E7]"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export .md</span>
            </button>

            {!isImmutable && (
              <button
                type="button"
                onClick={handleOpenDeleteConfirm}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#272C3A] bg-[#171A22] px-2.5 text-xs font-medium text-rose-300 transition-colors hover:border-[#5A2934] hover:bg-[#241419]"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Delete</span>
              </button>
            )}
          </div>
        </div>

        {/* Row 2: Fixed Google Docs-Style Formatting Toolbar */}
        {!isImmutable && editor && (
          <div
            role="toolbar"
            aria-label="Formatting toolbar"
            className="flex flex-wrap items-center gap-1 px-4 py-2 lg:px-6"
          >
            {/* Undo / Redo */}
            <ToolbarBtn
              label="Undo"
              onClick={() => editor.chain().focus().undo().run()}
              disabled={!toolbarState?.canUndo}
            >
              <Undo2 className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn
              label="Redo"
              onClick={() => editor.chain().focus().redo().run()}
              disabled={!toolbarState?.canRedo}
            >
              <Redo2 className="h-3.5 w-3.5" />
            </ToolbarBtn>

            <ToolbarDivider />

            {/* Heading level */}
            <select
              aria-label="Heading level"
              value={toolbarState?.headingLevel ?? '0'}
              onChange={(e) => {
                const lvl = Number(e.target.value);
                if (lvl === 0) {
                  editor.chain().focus().setParagraph().run();
                } else {
                  editor
                    .chain()
                    .focus()
                    .toggleHeading({level: lvl as 1 | 2 | 3})
                    .run();
                }
              }}
              className="h-7 rounded border border-[#282D3B] bg-[#0E1015] px-2 text-xs text-[#DCDAD2] focus:border-[#E0A83E]/60 focus:outline-none"
            >
              <option value="0">Normal text</option>
              <option value="1">Heading 1</option>
              <option value="2">Heading 2</option>
              <option value="3">Heading 3</option>
            </select>

            <ToolbarDivider />

            {/* Inline marks */}
            <ToolbarBtn
              label="Bold"
              active={toolbarState?.isBold}
              onClick={() => editor.chain().focus().toggleBold().run()}
            >
              <Bold className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn
              label="Italic"
              active={toolbarState?.isItalic}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            >
              <Italic className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn
              label="Underline"
              active={toolbarState?.isUnderline}
              onClick={() => editor.chain().focus().toggleUnderline().run()}
            >
              <UnderlineIcon className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn
              label="Strikethrough"
              active={toolbarState?.isStrike}
              onClick={() => editor.chain().focus().toggleStrike().run()}
            >
              <Strikethrough className="h-3.5 w-3.5" />
            </ToolbarBtn>

            <ToolbarDivider />

            {/* Lists */}
            <ToolbarBtn
              label="Bullet list"
              active={toolbarState?.isBulletList}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
            >
              <List className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn
              label="Ordered list"
              active={toolbarState?.isOrderedList}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
            >
              <ListOrdered className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn
              label="Task list"
              active={toolbarState?.isTaskList}
              onClick={() => editor.chain().focus().toggleTaskList().run()}
            >
              <CheckSquare className="h-3.5 w-3.5" />
            </ToolbarBtn>

            <ToolbarDivider />

            {/* Block elements */}
            <ToolbarBtn
              label="Blockquote"
              active={toolbarState?.isBlockquote}
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
            >
              <Quote className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn
              label="Code block"
              active={toolbarState?.isCodeBlock}
              onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            >
              <Code2 className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn
              label="Link"
              active={toolbarState?.isLink}
              onClick={handleOpenLinkDialog}
            >
              <Link2 className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn
              label="Insert 3x3 table"
              active={toolbarState?.isTable}
              onClick={() =>
                editor
                  .chain()
                  .focus()
                  .insertTable({rows: 3, cols: 3, withHeaderRow: true})
                  .run()
              }
            >
              <TableIcon className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <ToolbarBtn
              label="Horizontal rule"
              onClick={() => editor.chain().focus().setHorizontalRule().run()}
            >
              <Minus className="h-3.5 w-3.5" />
            </ToolbarBtn>

            <ToolbarDivider />

            {/* Clear formatting */}
            <ToolbarBtn
              label="Clear formatting"
              onClick={() =>
                editor.chain().focus().unsetAllMarks().clearNodes().run()
              }
            >
              <RemoveFormatting className="h-3.5 w-3.5" />
            </ToolbarBtn>

            {/* Insert workspace image (PNG, JPG, JPEG, GIF, WebP · max 10 MB) */}
            <ToolbarBtn
              label={`Insert image (PNG, JPG, GIF, WebP · max ${MAX_IMAGE_MB} MB)`}
              disabled={uploadingImage}
              onClick={() => imageInputRef.current?.click()}
            >
              <ImageIcon className="h-3.5 w-3.5" />
            </ToolbarBtn>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp"
              multiple
              className="hidden"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                if (picked.length > 0) {
                  void handleInsertImages(picked);
                }
                e.target.value = '';
              }}
            />
            {uploadingImage && (
              <span className="ml-1 text-[11px] text-[#E0A83E]">
                Importing image...
              </span>
            )}

            {/* Contextual Table Actions */}
            {toolbarState?.isTable && (
              <div className="ml-2 flex items-center gap-1 border-l border-[#252A38] pl-2 text-[11px]">
                <button
                  type="button"
                  onClick={() => editor.chain().focus().addRowAfter().run()}
                  className="rounded px-1.5 py-0.5 text-[#B8BDC9] hover:bg-[#1E222E] hover:text-white"
                >
                  +Row
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().addColumnAfter().run()}
                  className="rounded px-1.5 py-0.5 text-[#B8BDC9] hover:bg-[#1E222E] hover:text-white"
                >
                  +Col
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().deleteTable().run()}
                  className="rounded px-1.5 py-0.5 text-rose-300 hover:bg-rose-500/15"
                >
                  Delete table
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Main Workspace Split: Pageless Document Left + Drill-Down Folder Explorer Right */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Pageless Continuous Scroll Canvas */}
        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-8 sm:px-8">
          <div className="mx-auto max-w-3xl space-y-5">
          {externalConflict && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#523F1B] bg-[#19150E] px-4 py-3 text-xs"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="font-semibold text-[#F6DFA8]">
                  This note was edited outside Noodle
                </p>
                <p className="text-[#D8C9A3]">
                  Detected an external change in{' '}
                  <code className="font-mono">{externalConflict.path}</code>.
                  Choose whether to reload the file from disk or keep your current
                  version.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => onReloadExternal?.()}
                  className="rounded-md border border-[#E0A83E]/50 bg-[#151820] px-3 py-1.5 text-xs font-semibold text-[#F6DFA8] transition-colors hover:bg-[#1E2330]"
                >
                  Reload
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (externalConflict) {
                      entryRef.current = {
                        ...entryRef.current,
                        pillar: externalConflict.diskEntry.pillar,
                        fileName: externalConflict.diskEntry.fileName,
                        path: externalConflict.diskEntry.path,
                      };
                    }
                    externalConflictRef.current = null;
                    onKeepMineExternal?.();
                    if (editor && !isImmutable) {
                      void performSave(
                        titleRef.current,
                        categoryRef.current,
                        subfolderRef.current,
                        editor.getJSON() as TipTapDoc,
                      );
                    }
                  }}
                  className="rounded-md bg-[#E0A83E] px-3 py-1.5 text-xs font-semibold text-[#111216] transition-colors hover:bg-[#ECB955]"
                >
                  Keep mine
                </button>
              </div>
            </div>
          )}

          {saveError && (
            <div className="rounded-lg border border-[#5A2934] bg-[#1C1216] px-4 py-2.5 text-xs text-rose-200">
              {saveError}
            </div>
          )}

          {imageError && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-[#523F1B] bg-[#19150E] px-4 py-2.5 text-xs text-amber-200">
              <span>{imageError}</span>
              <button
                type="button"
                onClick={() => setImageError(null)}
                className="shrink-0 text-[11px] font-medium text-amber-300 underline hover:text-amber-100"
              >
                Dismiss
              </button>
            </div>
          )}

          {confirmDelete && (
            <div className="space-y-3 rounded-xl border border-[#5A2934] bg-[#1C1216] p-4 text-xs">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-semibold text-rose-200">
                    Delete &ldquo;{title || 'Untitled Note'}&rdquo;?
                  </p>
                  <p className="text-rose-200/80">
                    Removes this note from your workspace folder.
                  </p>
                  {loadingOrphanPreview ? (
                    <p className="text-rose-200/70">
                      Checking for unused images...
                    </p>
                  ) : orphanAssetsToDelete.length > 0 ? (
                    <div className="mt-2 rounded-lg bg-[#12141A] p-2.5 text-rose-100">
                      <p className="font-medium text-rose-200">
                        {needsFirstAssetConfirm
                          ? 'First-time cleanup confirmation — these unused images will also be deleted permanently:'
                          : 'These unused images will also be deleted:'}
                      </p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono text-[11px] text-rose-200/90">
                        {orphanAssetsToDelete.map((asset) => (
                          <li key={asset}>{asset}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="h-8 rounded-md border border-[#2C3140] bg-[#151820] px-3 text-xs font-medium text-[#C8CCD6] hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmDelete}
                    disabled={deleting || loadingOrphanPreview}
                    className="h-8 rounded-md bg-rose-500 px-3 text-xs font-semibold text-white hover:bg-rose-600 disabled:opacity-40"
                  >
                    {deleting ? 'Deleting...' : 'Confirm Delete'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Clean Note Title Only (folders moved to right-hand side panel) */}
          <div className="pb-3">
            <input
              type="text"
              value={title}
              readOnly={isImmutable}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="Untitled Note (auto-titles from first line)"
              aria-label="Note title"
              className="w-full bg-transparent font-serif text-3xl leading-tight font-semibold text-[#F5F1E8] placeholder-[#565C6E] focus:outline-none"
            />
          </div>

          {/* Distinct AI Output Visual Marker & Metadata */}
          {entry.note.aiMeta?.isAiGenerated && (
            <AiProvenanceBanner
              aiMeta={entry.note.aiMeta}
              onNavigateToBlock={onNavigateToBlock}
            />
          )}

          {/* Interactive Flashcard Deck / Practice Exam Toggle when saved in ai/ */}
          {(entry.note.aiMeta?.flashcards?.length ||
            entry.note.aiMeta?.examQuestions?.length) && (
            <div className="space-y-4">
              <div className="inline-flex items-center gap-1 rounded-lg border border-[#252A38] bg-[#11131A] p-1 text-xs">
                <button
                  type="button"
                  onClick={() => setAiInteractiveTab('interactive')}
                  className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                    aiInteractiveTab === 'interactive'
                      ? 'bg-[#E0A83E] font-semibold text-[#111216]'
                      : 'text-[#9CA1AE] hover:text-[#ECEBE6]'
                  }`}
                >
                  {entry.note.aiMeta?.flashcards?.length
                    ? 'Interactive Flashcards'
                    : 'Interactive Practice Exam'}
                </button>
                <button
                  type="button"
                  onClick={() => setAiInteractiveTab('document')}
                  className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                    aiInteractiveTab === 'document'
                      ? 'bg-[#E0A83E] font-semibold text-[#111216]'
                      : 'text-[#9CA1AE] hover:text-[#ECEBE6]'
                  }`}
                >
                  Full Note
                </button>
              </div>

              {aiInteractiveTab === 'interactive' &&
                entry.note.aiMeta?.flashcards && (
                  <FlashcardDeckView
                    flashcards={entry.note.aiMeta.flashcards}
                    sources={entry.note.aiMeta.sourcesUsed}
                    onNavigateToBlock={onNavigateToBlock}
                  />
                )}

              {aiInteractiveTab === 'interactive' &&
                entry.note.aiMeta?.examQuestions && (
                  <PracticeExamView
                    questions={entry.note.aiMeta.examQuestions}
                    sources={entry.note.aiMeta.sourcesUsed}
                    onNavigateToBlock={onNavigateToBlock}
                  />
                )}
            </div>
          )}

          {/* Pageless TipTap ProseMirror Surface */}
          <div
            ref={proseContainerRef}
            onClick={handleProseClick}
            className={`noodle-prosemirror pb-12 ${
              aiInteractiveTab === 'interactive' &&
              (entry.note.aiMeta?.flashcards?.length ||
                entry.note.aiMeta?.examQuestions?.length)
                ? 'hidden'
                : ''
            }`}
          >
            <EditorContent editor={editor} />
          </div>

          {onLinkSuggestion &&
            onDismissSuggestion &&
            onRemoveBacklink &&
            onNavigateToBlock && (
              <ConnectionsPanel
                currentNoteId={entry.note.id}
                backlinks={backlinks}
                suggestions={suggestions}
                mode={suggestionMode}
                loading={suggestionsLoading}
                onLinkSuggestion={(suggestion) =>
                  onLinkSuggestion(suggestion, resolveActiveBlockId())
                }
                onDismissSuggestion={onDismissSuggestion}
                onRemoveBacklink={onRemoveBacklink}
                onNavigateToBlock={onNavigateToBlock}
              />
            )}
          </div>
        </div>

        {/* Right-Hand Drill-Down Folder Explorer Panel (browsing never auto-moves the open note) */}
        {folderPanelOpen && (
          <aside
            aria-label="Folder explorer"
            className="absolute inset-y-0 right-0 z-20 flex w-72 shrink-0 flex-col border-l border-[#232734] bg-[#101218] shadow-2xl md:static md:z-auto md:shadow-none xl:w-80"
          >
            {/* Dynamic Drill-Down Header: Folders -> Parent Folder -> Subfolder */}
            <div className="flex items-center justify-between gap-2 border-b border-[#1E222E] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                {browseCategory !== null && (
                  <button
                    type="button"
                    onClick={() => {
                      setAddingSubfolder(false);
                      setNewSubDraft('');
                      if (browseSubfolder !== null) {
                        setBrowseSubfolder(null);
                      } else {
                        setBrowseCategory(null);
                      }
                    }}
                    aria-label={
                      browseSubfolder !== null
                        ? `Back to ${browseCategory}`
                        : 'Back to Folders'
                    }
                    title={
                      browseSubfolder !== null
                        ? `Back to ${browseCategory}`
                        : 'Back to Folders'
                    }
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#272C3A] bg-[#161922] text-[#C8CCD6] transition-colors hover:border-[#E0A83E]/50 hover:text-[#F4F0E7]"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                  </button>
                )}

                <div className="min-w-0">
                  {browseCategory === null ? (
                    <h2 className="truncate font-serif text-sm font-semibold text-[#F4F0E7]">
                      Folders
                    </h2>
                  ) : browseSubfolder === null ? (
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-[2px] ${
                          getCategoryStyle(browseCategory, categoryConfigs).dot
                        }`}
                      />
                      <h2 className="truncate font-serif text-sm font-semibold text-[#F4F0E7]">
                        {browseCategory}
                      </h2>
                    </div>
                  ) : (
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Folder className="h-3.5 w-3.5 shrink-0 text-[#E0A83E]" />
                        <h2 className="truncate font-serif text-sm font-semibold text-[#F4F0E7]">
                          {browseSubfolder}
                        </h2>
                      </div>
                      <p className="truncate text-[10px] text-[#7D8496]">
                        in {browseCategory}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {browseCategory === null && onOpenCategoryManager && (
                <button
                  type="button"
                  onClick={onOpenCategoryManager}
                  title="Customize folders & subfolders"
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-[#272C3A] bg-[#161922] px-2 text-[11px] font-medium text-[#B8BDC9] transition-colors hover:border-[#E0A83E] hover:text-[#F3CA77]"
                >
                  <SlidersHorizontal className="h-3 w-3 text-[#E0A83E]" />
                  <span>Edit</span>
                </button>
              )}
            </div>

            {/* Drill-Down Body */}
            <div className="flex-1 space-y-4 overflow-y-auto p-3 text-xs">
              {browseCategory === null ? (
                /* Level 0: All Parent Folders */
                <div className="space-y-1">
                  {categoryConfigs.map((cat) => {
                    const style = getCategoryStyle(cat.name, categoryConfigs);
                    const totalInCat = allNotes.filter(
                      (n) =>
                        n.note.category.toLowerCase() === cat.name.toLowerCase(),
                    ).length;
                    const containsCurrent =
                      category.toLowerCase() === cat.name.toLowerCase();
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => {
                          setBrowseCategory(cat.name);
                          setBrowseSubfolder(null);
                          setAddingSubfolder(false);
                          setNewSubDraft('');
                        }}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left transition-colors ${
                          containsCurrent
                            ? 'border-l-2 border-[#E0A83E] bg-[#1C202B] text-[#F5F1E8]'
                            : 'text-[#D5D4CD] hover:bg-[#171A23]'
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={`h-2 w-2 shrink-0 rounded-[2px] ${style.dot}`}
                          />
                          <span className="truncate font-medium">
                            {cat.name}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-[#7D8496]">
                          <span className="tabular-nums">{totalInCat}</span>
                          <ChevronRight className="h-3.5 w-3.5" />
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : browseSubfolder === null ? (
                /* Level 1: Inside Parent Folder -> Subfolders + Notes inside parent */
                <>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between px-1">
                      <span className="text-[11px] font-medium text-[#7D8496]">
                        Subfolders
                      </span>
                      {!isImmutable && !addingSubfolder && (
                        <button
                          type="button"
                          onClick={() => setAddingSubfolder(true)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-[#E0A83E] hover:text-[#F3CA77]"
                        >
                          <FolderPlus className="h-3 w-3" />
                          <span>New</span>
                        </button>
                      )}
                    </div>

                    {addingSubfolder && (
                      <div className="flex items-center gap-1.5 rounded-lg border border-[#343A4E] bg-[#141720] p-1.5">
                        <input
                          type="text"
                          autoFocus
                          value={newSubDraft}
                          onChange={(e) => setNewSubDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void handleCreateSubfolderInBrowser();
                            } else if (e.key === 'Escape') {
                              setAddingSubfolder(false);
                              setNewSubDraft('');
                            }
                          }}
                          placeholder={`Subfolder in ${browseCategory}...`}
                          className="h-7 min-w-0 flex-1 rounded bg-[#0C0E13] px-2 text-[11px] text-[#ECEBE6] placeholder-[#656C7D] focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => void handleCreateSubfolderInBrowser()}
                          className="h-7 rounded bg-[#E0A83E] px-2 text-[11px] font-semibold text-[#111216]"
                        >
                          Add
                        </button>
                      </div>
                    )}

                    {browsedSubfolders.length === 0 ? (
                      <p className="px-1 text-[11px] text-[#686F80]">
                        No subfolders in {browseCategory}.
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {browsedSubfolders.map((sub) => {
                          const subCount = allNotes.filter(
                            (n) =>
                              n.note.category.toLowerCase() ===
                                browseCategory.toLowerCase() &&
                              (n.note.subfolder ?? '').toLowerCase() ===
                                sub.toLowerCase(),
                          ).length;
                          const containsCurrent =
                            category.toLowerCase() ===
                              browseCategory.toLowerCase() &&
                            subfolder.toLowerCase() === sub.toLowerCase();
                          return (
                            <button
                              key={sub}
                              type="button"
                              onClick={() => {
                                setBrowseSubfolder(sub);
                                setAddingSubfolder(false);
                                setNewSubDraft('');
                              }}
                              className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left transition-colors ${
                                containsCurrent
                                  ? 'border-l-2 border-[#E0A83E] bg-[#1C202B] text-[#F5F1E8]'
                                  : 'text-[#D5D4CD] hover:bg-[#171A23]'
                              }`}
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                <Folder className="h-3.5 w-3.5 shrink-0 text-[#E0A83E]" />
                                <span className="truncate font-medium">
                                  {sub}
                                </span>
                              </div>
                              <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-[#7D8496]">
                                <span className="tabular-nums">{subCount}</span>
                                <ChevronRight className="h-3.5 w-3.5" />
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5 pt-2">
                    <div className="flex items-center justify-between px-1">
                      <span className="text-[11px] font-medium text-[#7D8496]">
                        Notes in {browseCategory}
                      </span>
                      {onCreateNoteInFolder && (
                        <button
                          type="button"
                          onClick={() => onCreateNoteInFolder(browseCategory)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-[#E0A83E] hover:text-[#F3CA77]"
                        >
                          <Plus className="h-3 w-3" />
                          <span>New note</span>
                        </button>
                      )}
                    </div>

                    {browsedDirectNotes.length === 0 ? (
                      <p className="px-1 text-[11px] text-[#686F80]">
                        No notes directly in {browseCategory}.
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {browsedDirectNotes.map((item) => {
                          const isCurrent = item.note.id === entry.note.id;
                          return (
                            <button
                              key={item.note.id}
                              type="button"
                              onClick={() => void handleOpenNoteFromPanel(item)}
                              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                                isCurrent
                                  ? 'bg-[#1D2230] text-[#F6DFA8]'
                                  : 'text-[#C8CCD6] hover:bg-[#171A23] hover:text-[#F4F0E7]'
                              }`}
                            >
                              <FileText className="h-3.5 w-3.5 shrink-0 text-[#888F9F]" />
                              <span className="min-w-0 flex-1 truncate font-medium">
                                {item.note.title}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                /* Level 2: Inside Subfolder -> Header replaced by Subfolder, lists notes inside it */
                <div className="space-y-2">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[11px] font-medium text-[#7D8496] tabular-nums">
                      Notes ({browsedSubfolderNotes.length})
                    </span>
                    {onCreateNoteInFolder && (
                      <button
                        type="button"
                        onClick={() =>
                          onCreateNoteInFolder(browseCategory, browseSubfolder)
                        }
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-[#E0A83E] hover:text-[#F3CA77]"
                      >
                        <Plus className="h-3 w-3" />
                        <span>New note</span>
                      </button>
                    )}
                  </div>

                  {browsedSubfolderNotes.length === 0 ? (
                    <p className="px-1 text-[11px] text-[#686F80]">
                      No notes in {browseSubfolder} yet.
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {browsedSubfolderNotes.map((item) => {
                        const isCurrent = item.note.id === entry.note.id;
                        return (
                          <button
                            key={item.note.id}
                            type="button"
                            onClick={() => void handleOpenNoteFromPanel(item)}
                            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                              isCurrent
                                ? 'bg-[#1D2230] text-[#F6DFA8]'
                                : 'text-[#C8CCD6] hover:bg-[#171A23] hover:text-[#F4F0E7]'
                            }`}
                          >
                            <FileText className="h-3.5 w-3.5 shrink-0 text-[#888F9F]" />
                            <span className="min-w-0 flex-1 truncate font-medium">
                              {item.note.title}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer: Current note folder & explicit non-accidental Move button */}
            <div className="space-y-2 border-t border-[#1E222E] bg-[#0D0F14] px-3.5 py-3 text-[11px]">
              <div className="flex items-center justify-between gap-2 text-[#888F9F]">
                <span>Current note:</span>
                <span className="truncate font-medium text-[#D5D4CD]">
                  {subfolder ? `${category} / ${subfolder}` : category}
                </span>
              </div>

              {movedNotice && (
                <p className="font-medium text-emerald-300">{movedNotice}</p>
              )}

              {!isImmutable && isViewingDifferentFolder && browseCategory && (
                <button
                  type="button"
                  onClick={() =>
                    moveOpenNoteTo(browseCategory, browseSubfolder ?? '')
                  }
                  className="h-8 w-full rounded-lg bg-[#232018] px-3 text-center font-medium text-[#F3CA77] transition-colors hover:bg-[#322B1E]"
                >
                  Move current note to{' '}
                  {browseSubfolder ? browseSubfolder : browseCategory}
                </button>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Link URL Dialog */}
      {linkModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="insert-link-title"
            className="w-full max-w-md rounded-xl border border-[#2A2F3E] bg-[#151820] p-5 shadow-2xl"
          >
            <h3
              id="insert-link-title"
              className="font-serif text-base font-semibold text-[#F4F0E7]"
            >
              Insert or Edit Link
            </h3>
            <p className="mt-1 text-xs text-[#888F9F]">
              Only <code className="font-mono">http://</code>,{' '}
              <code className="font-mono">https://</code>, or{' '}
              <code className="font-mono">mailto:</code> links are supported.
            </p>
            <form onSubmit={handleApplyLink} className="mt-4 space-y-3">
              <input
                type="text"
                autoFocus
                value={linkUrlInput}
                onChange={(e) => {
                  setLinkUrlInput(e.target.value);
                  setLinkUrlError(null);
                }}
                placeholder="https://example.com"
                className="h-9 w-full rounded-lg border border-[#282D3B] bg-[#0E1015] px-3 text-xs text-[#ECEBE6] placeholder-[#656C7D] focus:border-[#E0A83E] focus:outline-none"
              />
              {linkUrlError && (
                <p className="text-xs text-rose-400">{linkUrlError}</p>
              )}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setLinkModalOpen(false)}
                  className="inline-flex h-8 items-center rounded-md border border-[#282D3B] px-3 text-xs text-[#B2B7C4] hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="inline-flex h-8 items-center rounded-md bg-[#E0A83E] px-3.5 text-xs font-semibold text-[#111216] hover:bg-[#ECB955]"
                >
                  Apply Link
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolbarBtn({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E0A83E] ${
        active
          ? 'bg-[#232018] text-[#F3CA77]'
          : 'text-[#B4B9C6] hover:bg-[#1E222E] hover:text-[#F4F0E7]'
      } disabled:cursor-not-allowed disabled:opacity-35`}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px bg-[#252A38]" />;
}

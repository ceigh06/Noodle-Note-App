import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  KeySetupModal,
  NewNoteModal,
  NonEmptyFolderModal,
} from './components/Modals';
import {MiniNotebook} from './components/MiniNotebook';
import {AiChatPanel} from './components/AiChatPanel';
import {NoteEditorView} from './components/NoteEditorView';
import {Sidebar} from './components/Sidebar';
import {SourceDocumentView} from './components/SourceDocumentView';
import {TopBar} from './components/TopBar';
import {DEMO_NOTES} from './data/demoNotes';
import {getStoredSourceDocuments} from './db/noodleDb';
import {markdownToTiptap} from './editor/markdownCodec';
import {
  computeCanonicalContentHash,
  createUuid,
  CURRENT_SCHEMA_VERSION,
  deriveFirstLineTitle,
  ensureBlockIds,
  validateNoteAssetPaths,
} from './editor/noteSchema';
import {extractPlainText} from './editor/plainText';
import {useHashRoute} from './hooks/useHashRoute';
import {DiagnosticsPage} from './pages/DiagnosticsPage';
import {GapAnalysisPage} from './pages/GapAnalysisPage';
import {OrganizePage} from './pages/OrganizePage';
import {SettingsPage} from './pages/SettingsPage';
import {SetupPage} from './pages/SetupPage';
import {StudyPage} from './pages/StudyPage';
import {SynthesizerPage} from './pages/SynthesizerPage';
import {TrustTuningPage} from './pages/TrustTuningPage';
import {WorkspacePage} from './pages/WorkspacePage';
import {DEFAULT_EMBEDDING_MODEL_ID} from './search/chunker';
import {
  cancelEmbeddingDownloadOrIndexing,
  dismissConnection,
  ensureModelIdConsistency,
  findSuggestedConnections,
  getBacklinksForDocument,
  getEmbeddingProgressSnapshot,
  getStoredEmbeddingConfig,
  initializeLocalEmbeddingModel,
  linkSuggestedConnection,
  removeExplicitBacklink,
  searchWorkspaceBlocks,
  subscribeEmbeddingProgress,
  syncLocalSearchIndex,
} from './search/localSearchService';
import {
  createNote,
  deleteAssetsFromWorkspace,
  deleteNote,
  FolderInspection,
  forgetSavedWorkspace,
  importDemoPdfSource,
  initializeWorkspaceFolders,
  isFileSystemAccessSupported,
  loadDemoSourceDocuments,
  pickWorkspaceFolder,
  reconnectSavedWorkspace,
  removeNoteFromAssetsIndex,
  restoreSavedWorkspace,
  saveAiSynthesizedNote,
  scanSourceDocumentsInWorkspace,
  scanWorkspaceChanges,
  StorageError,
  syncNoteAssetsIndex,
  updateNote,
} from './storage/workspaceStorage';
import {
  AiNoteMetadata,
  BacklinkRecord,
  Category,
  EmbeddingModelConfig,
  EmbeddingProgressState,
  ExternalEditConflict,
  Pillar,
  PillarFilter,
  ScanProblem,
  SearchResultItem,
  SourceDocumentEntry,
  StoredNoteEntry,
  SuggestedConnection,
  TipTapDoc,
  VoiceRuntimeState,
  VoiceSearchSettings,
  WhisperProgressState,
  WorkspaceConnectionState,
  WorkspaceScanSummary,
} from './types/noodle';
import {
  captureUtteranceAfterWakeWord,
  EphemeralCaptureHandle,
  killAllMicrophoneAccess,
  KillSwitchReport,
  queryMicrophonePermissionState,
  startEphemeralMicCapture,
  subscribeActiveMicrophoneTracks,
} from './voice/microphoneController';
import {
  startPorcupineWakeWord,
  stopPorcupineWakeWord,
} from './voice/porcupineWakeWord';
import {
  getDefaultVoiceSearchSettings,
  loadVoiceSearchSettings,
  matchesPushToTalkHotkey,
  saveVoiceSearchSettings,
} from './voice/voiceConfig';
import {
  cancelWhisperWork,
  getWhisperProgressSnapshot,
  initializeWhisperModel,
  subscribeWhisperProgress,
  transcribeEphemeralAudio,
} from './voice/voiceSearchService';

export default function App() {
  const {route, navigate} = useHashRoute();

  const [connectionState, setConnectionState] =
    useState<WorkspaceConnectionState>('checking');
  const [folderName, setFolderName] = useState<string | null>(null);
  const [restoredHandle, setRestoredHandle] =
    useState<FileSystemDirectoryHandle | null>(null);
  const [pendingInit, setPendingInit] = useState<{
    handle: FileSystemDirectoryHandle;
    inspection: FolderInspection;
  } | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);

  const [notes, setNotes] = useState<StoredNoteEntry[]>(DEMO_NOTES);
  const [sourceDocuments, setSourceDocuments] = useState<SourceDocumentEntry[]>(
    [],
  );
  const [activePillar, setActivePillar] = useState<PillarFilter>('all');
  const [activeCategory, setActiveCategory] = useState<Category | 'All'>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchMode, setSearchMode] = useState<'semantic' | 'word-match'>(
    'word-match',
  );
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [embeddingConfig, setEmbeddingConfig] = useState<EmbeddingModelConfig>({
    modelId: DEFAULT_EMBEDDING_MODEL_ID,
    vectorSize: 384,
    isDownloaded: false,
  });
  const [embeddingProgress, setEmbeddingProgress] =
    useState<EmbeddingProgressState>(() => getEmbeddingProgressSnapshot());
  const [miniNotebookOpen, setMiniNotebookOpen] = useState(false);
  const [aiChatOpen, setAiChatOpen] = useState(false);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [keySetupOpen, setKeySetupOpen] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<StoredNoteEntry | null>(
    null,
  );
  const [selectedSourceDoc, setSelectedSourceDoc] =
    useState<SourceDocumentEntry | null>(null);
  const [targetBlockId, setTargetBlockId] = useState<string | null>(null);
  const [backlinks, setBacklinks] = useState<BacklinkRecord[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestedConnection[]>([]);
  const [suggestionMode, setSuggestionMode] = useState<
    'semantic' | 'word-match'
  >('word-match');
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [scanProblems, setScanProblems] = useState<ScanProblem[]>([]);
  const [scanning, setScanning] = useState(false);
  const [externalConflict, setExternalConflict] =
    useState<ExternalEditConflict | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);

  // Experimental Voice Search (strictly OFF by default; Porcupine AccessKey held in RAM only)
  const [voiceSettings, setVoiceSettings] = useState<VoiceSearchSettings>(() =>
    getDefaultVoiceSearchSettings(),
  );
  const [whisperProgress, setWhisperProgress] = useState<WhisperProgressState>(
    () => getWhisperProgressSnapshot(),
  );
  const [porcupineAccessKey, setPorcupineAccessKey] = useState('');
  const [voiceRuntime, setVoiceRuntime] = useState<VoiceRuntimeState>({
    phase: 'off',
    activeTrackCount: 0,
    micPermissionState: 'unknown',
    lastTranscript: '',
    lastError: null,
    wakeWordActive: false,
    wakeWordStatusMessage: null,
  });

  const selectedEntryRef = useRef<StoredNoteEntry | null>(null);
  selectedEntryRef.current = selectedEntry;
  const selectedSourceDocRef = useRef<SourceDocumentEntry | null>(null);
  selectedSourceDocRef.current = selectedSourceDoc;
  const notesRef = useRef<StoredNoteEntry[]>(notes);
  notesRef.current = notes;
  const sourceDocumentsRef = useRef<SourceDocumentEntry[]>(sourceDocuments);
  sourceDocumentsRef.current = sourceDocuments;
  const aiEnabledRef = useRef(aiEnabled);
  aiEnabledRef.current = aiEnabled;
  const embeddingConfigRef = useRef<EmbeddingModelConfig>(embeddingConfig);
  embeddingConfigRef.current = embeddingConfig;
  const voiceSettingsRef = useRef<VoiceSearchSettings>(voiceSettings);
  voiceSettingsRef.current = voiceSettings;
  const activeCaptureRef = useRef<EphemeralCaptureHandle | null>(null);
  const hotkeyHeldRef = useRef(false);

  const triggerIndexSync = useCallback(
    async (
      nextNotes: StoredNoteEntry[],
      nextSources: SourceDocumentEntry[],
      forceComputeVectors?: boolean,
      modelIdOverride?: string,
    ) => {
      const computeVectors =
        forceComputeVectors ??
        (aiEnabledRef.current && embeddingConfigRef.current.isDownloaded);
      try {
        await syncLocalSearchIndex({
          notes: nextNotes,
          sources: nextSources,
          computeVectors,
          modelId: modelIdOverride ?? embeddingConfigRef.current.modelId,
        });
      } catch {
        // Worker cancellation or download error is surfaced via embeddingProgress
      }
    },
    [],
  );

  const runWorkspaceScan = useCallback(
    async (
      reason: WorkspaceScanSummary['reason'] = 'manual',
      options?: {force?: boolean},
    ) => {
      setScanning(true);
      try {
        const [summary, sourceScan] = await Promise.all([
          scanWorkspaceChanges(reason, options),
          scanSourceDocumentsInWorkspace(),
        ]);
        setNotes(summary.entries);
        setSourceDocuments(sourceScan.documents);
        setScanProblems([...summary.problems, ...sourceScan.problems]);

        const open = selectedEntryRef.current;
        if (open) {
          const diskMatch = summary.entries.find(
            (item) => item.note.id === open.note.id,
          );
          if (diskMatch) {
            const wasEditedInScan = summary.editedNoteIds.includes(open.note.id);
            const divergesFromOpen =
              diskMatch.note.contentHash !== open.note.contentHash ||
              diskMatch.note.title !== open.note.title ||
              diskMatch.note.category !== open.note.category;

            if (wasEditedInScan || divergesFromOpen) {
              setExternalConflict({
                noteId: open.note.id,
                path: diskMatch.path ?? `${diskMatch.pillar}/${diskMatch.fileName}`,
                pillar: diskMatch.pillar,
                fileName: diskMatch.fileName,
                diskEntry: diskMatch,
                detectedAt: new Date().toISOString(),
              });
            } else if (
              diskMatch.pillar !== open.pillar ||
              diskMatch.fileName !== open.fileName ||
              diskMatch.path !== open.path
            ) {
              setSelectedEntry(diskMatch);
            }
          }
        }

        const openSource = selectedSourceDocRef.current;
        if (openSource) {
          const refreshedSource = sourceScan.documents.find(
            (d) => d.id === openSource.id,
          );
          if (refreshedSource) {
            setSelectedSourceDoc(refreshedSource);
          } else {
            setSelectedSourceDoc(null);
          }
        }

        void triggerIndexSync(summary.entries, sourceScan.documents);
      } catch (err) {
        if (err instanceof StorageError && err.code === 'NO_WORKSPACE') {
          return;
        }
        throw err;
      } finally {
        setScanning(false);
      }
    },
    [triggerIndexSync],
  );

  const refreshDiskNotes = useCallback(async () => {
    await runWorkspaceScan('startup', {force: true});
  }, [runWorkspaceScan]);

  const finalizeFolderConnection = useCallback(
    async (handle: FileSystemDirectoryHandle) => {
      await initializeWorkspaceFolders(handle);
      setFolderName(handle.name);
      setRestoredHandle(handle);
      setPendingInit(null);
      setSelectedEntry(null);
      setSelectedSourceDoc(null);
      setTargetBlockId(null);
      setConnectionState('connected');
      await refreshDiskNotes();
      if (route === '/') {
        navigate('/workspace');
      }
    },
    [navigate, refreshDiskNotes, route],
  );

  // Subscribe to local worker progress and load stored embedding + voice settings
  useEffect(() => {
    const unsubscribe = subscribeEmbeddingProgress(setEmbeddingProgress);
    const unsubWhisper = subscribeWhisperProgress(setWhisperProgress);
    const unsubTracks = subscribeActiveMicrophoneTracks((activeTrackCount) => {
      setVoiceRuntime((prev) => ({...prev, activeTrackCount}));
    });
    void getStoredEmbeddingConfig().then((cfg) => {
      setEmbeddingConfig(cfg);
      embeddingConfigRef.current = cfg;
    });
    void loadVoiceSearchSettings().then((vs) => {
      setVoiceSettings(vs);
      voiceSettingsRef.current = vs;
      setVoiceRuntime((prev) => ({
        ...prev,
        phase: vs.experimentalVoiceEnabled ? 'idle' : 'off',
      }));
    });
    void queryMicrophonePermissionState().then((perm) => {
      setVoiceRuntime((prev) => ({...prev, micPermissionState: perm}));
    });
    return () => {
      unsubscribe();
      unsubWhisper();
      unsubTracks();
    };
  }, []);

  // Restore saved workspace handle from IndexedDB on boot
  useEffect(() => {
    let cancelled = false;
    async function activateDemoWorkspace(
      nextState: WorkspaceConnectionState,
    ): Promise<void> {
      const demoSources = await loadDemoSourceDocuments().catch(() => []);
      if (cancelled) {
        return;
      }
      setSourceDocuments(demoSources);
      setConnectionState(nextState);
      void triggerIndexSync(DEMO_NOTES, demoSources);
    }

    async function boot() {
      if (!isFileSystemAccessSupported()) {
        if (!cancelled) {
          await activateDemoWorkspace('unsupported');
        }
        return;
      }

      try {
        const restored = await restoreSavedWorkspace();
        if (cancelled) {
          return;
        }
        if (!restored) {
          await activateDemoWorkspace('unselected');
          return;
        }

        setRestoredHandle(restored.handle);
        setFolderName(restored.folderName);

        if (restored.permission === 'granted') {
          if (restored.inspection && restored.inspection.hasAllNoodleDirs) {
            setConnectionState('connected');
            await refreshDiskNotes();
          } else if (restored.inspection && !restored.inspection.isEmpty) {
            setPendingInit({
              handle: restored.handle,
              inspection: restored.inspection,
            });
            setConnectionState('confirm-non-empty');
          } else {
            await finalizeFolderConnection(restored.handle);
          }
        } else {
          const cachedSources = await getStoredSourceDocuments().catch(() => []);
          if (!cancelled && cachedSources.length > 0) {
            setSourceDocuments(cachedSources);
          }
          setConnectionState('restored-needs-permission');
        }
      } catch {
        if (!cancelled) {
          await activateDemoWorkspace('unselected');
        }
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [finalizeFolderConnection, refreshDiskNotes, triggerIndexSync]);

  // Background workspace scanning on tab focus, visibility regain, and every 30s while visible
  useEffect(() => {
    if (connectionState !== 'connected') {
      return;
    }

    const handleFocus = () => {
      void runWorkspaceScan('focus');
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void runWorkspaceScan('focus');
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void runWorkspaceScan('interval');
      }
    }, 30_000);

    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(intervalId);
    };
  }, [connectionState, runWorkspaceScan]);

  const handleSelectFolder = async () => {
    if (workspaceBusy) {
      return;
    }
    setWorkspaceBusy(true);
    setPickerError(null);
    try {
      const {handle, inspection} = await pickWorkspaceFolder();
      if (!inspection.isEmpty && !inspection.hasNoodleManifest) {
        setPendingInit({handle, inspection});
        setConnectionState('confirm-non-empty');
      } else {
        await finalizeFolderConnection(handle);
      }
    } catch (err) {
      if (err instanceof StorageError) {
        if (err.code === 'USER_CANCELLED') {
          return;
        }
        if (err.code === 'BLOCKED_IFRAME') {
          setConnectionState('blocked-iframe');
          setPickerError(err.message);
          return;
        }
        if (err.code === 'UNSUPPORTED') {
          setConnectionState('unsupported');
          setPickerError(err.message);
          return;
        }
        setPickerError(err.message);
      } else {
        setPickerError((err as Error).message || 'Unable to select folder.');
      }
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const handleReconnect = async () => {
    if (!restoredHandle || workspaceBusy) {
      return;
    }
    setWorkspaceBusy(true);
    setPickerError(null);
    try {
      const result = await reconnectSavedWorkspace(restoredHandle);
      if (result.permission !== 'granted') {
        setPickerError(
          'Permission was not granted. Click "Reconnect workspace" and allow access to continue.',
        );
        return;
      }

      if (result.inspection && result.inspection.hasAllNoodleDirs) {
        setFolderName(restoredHandle.name);
        setConnectionState('connected');
        await refreshDiskNotes();
        if (route === '/') {
          navigate('/workspace');
        }
      } else if (result.inspection && !result.inspection.isEmpty) {
        setPendingInit({
          handle: restoredHandle,
          inspection: result.inspection,
        });
        setConnectionState('confirm-non-empty');
      } else {
        await finalizeFolderConnection(restoredHandle);
      }
    } catch (err) {
      setPickerError((err as Error).message || 'Could not reconnect folder.');
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const handleForgetWorkspace = async () => {
    await forgetSavedWorkspace();
    setRestoredHandle(null);
    setFolderName(null);
    setPendingInit(null);
    setPickerError(null);
    setSelectedEntry(null);
    setSelectedSourceDoc(null);
    setTargetBlockId(null);
    setExternalConflict(null);
    setScanProblems([]);
    const demoSources = await loadDemoSourceDocuments().catch(() => []);
    setSourceDocuments(demoSources);
    setLocalSearchQuery('');
    setSearchResults([]);
    setBacklinks([]);
    setSuggestions([]);
    setNotes(DEMO_NOTES);
    setConnectionState(
      isFileSystemAccessSupported() ? 'unselected' : 'unsupported',
    );
    void triggerIndexSync(DEMO_NOTES, demoSources);
  };

  const pillarCounts = useMemo(
    () => ({
      all: notes.length + sourceDocuments.length,
      sources:
        notes.filter((n) => n.pillar === 'sources').length +
        sourceDocuments.length,
      manual: notes.filter((n) => n.pillar === 'manual').length,
      ai: notes.filter((n) => n.pillar === 'ai').length,
    }),
    [notes, sourceDocuments.length],
  );

  const createInMemoryNote = async (
    title: string,
    category: Category,
    content: TipTapDoc,
  ): Promise<StoredNoteEntry> => {
    const now = new Date().toISOString();
    const id = createUuid();
    const ensured = ensureBlockIds(content);
    const {text} = extractPlainText(ensured);
    const normalized = text.replace(/\s+/g, ' ').trim();
    const wordCount = normalized ? normalized.split(/\s+/).length : 0;
    const hash = await computeCanonicalContentHash(ensured);

    return {
      fileName: `demo-${id.slice(0, 8)}.json`,
      pillar: 'manual',
      excerpt: (normalized || 'Empty note.').slice(0, 180),
      wordCount,
      note: {
        id,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        title,
        category,
        pillar: 'manual',
        createdAt: now,
        updatedAt: now,
        contentHash: hash,
        content: ensured,
      },
    };
  };

  const handleCreateManualNote = async (
    title: string,
    category: Category,
    body: string,
  ) => {
    let created: StoredNoteEntry;
    if (connectionState === 'connected') {
      created = await createNote({
        pillar: 'manual',
        title,
        category,
        bodyText: body,
      });
      await refreshDiskNotes();
    } else {
      const text = body.trim();
      created = await createInMemoryNote(title, category, {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: {id: createUuid()},
            ...(text ? {content: [{type: 'text', text}]} : {}),
          },
        ],
      });
      const updatedList = [created, ...notesRef.current];
      setNotes(updatedList);
      void triggerIndexSync(updatedList, sourceDocumentsRef.current);
    }

    if (activePillar === 'sources' || activePillar === 'ai') {
      setActivePillar('manual');
    }
    if (activeCategory !== 'All' && activeCategory !== category) {
      setActiveCategory('All');
    }
    setSelectedSourceDoc(null);
    setTargetBlockId(null);
    setSelectedEntry(created);
    if (route !== '/workspace') {
      navigate('/workspace');
    }
  };

  const handleImportMarkdown = async (file: File) => {
    const rawText = await file.text();
    const doc = markdownToTiptap(rawText);
    const derived = deriveFirstLineTitle(doc);
    const fallbackFileTitle = file.name.replace(/\.(md|markdown|txt)$/i, '');
    const title =
      derived && derived !== 'Untitled Note'
        ? derived
        : fallbackFileTitle || 'Imported Note';

    let created: StoredNoteEntry;
    if (connectionState === 'connected') {
      created = await createNote({
        pillar: 'manual',
        title,
        category: 'Study',
        content: doc,
      });
      await refreshDiskNotes();
    } else {
      created = await createInMemoryNote(title, 'Study', doc);
      const updatedList = [created, ...notesRef.current];
      setNotes(updatedList);
      void triggerIndexSync(updatedList, sourceDocumentsRef.current);
    }

    setActivePillar('manual');
    setActiveCategory('All');
    setSelectedSourceDoc(null);
    setTargetBlockId(null);
    setSelectedEntry(created);
    if (route !== '/workspace') {
      navigate('/workspace');
    }
  };

  const handleImportDemoPdf = async (file: File) => {
    if (connectionState === 'connected') {
      return;
    }
    const addedDoc = await importDemoPdfSource(file);
    const nextSources = [
      addedDoc,
      ...sourceDocumentsRef.current.filter((d) => d.id !== addedDoc.id),
    ];
    setSourceDocuments(nextSources);
    void triggerIndexSync(notesRef.current, nextSources);
    setActivePillar('sources');
    setActiveCategory('All');
    setSelectedEntry(null);
    setTargetBlockId(null);
    setSelectedSourceDoc(addedDoc);
    if (route !== '/workspace') {
      navigate('/workspace');
    }
  };

  const handleSaveAiNote = async (payload: {
    targetPillar: Pillar;
    title: string;
    category: Category;
    content: TipTapDoc;
    aiMeta: AiNoteMetadata;
  }): Promise<StoredNoteEntry> => {
    if (payload.targetPillar !== 'ai') {
      throw new Error(
        `Refused write to "${payload.targetPillar}/": AI synthesis notes may ONLY be saved inside ai/.`,
      );
    }

    if (connectionState === 'connected') {
      const created = await saveAiSynthesizedNote({
        targetPillar: 'ai',
        title: payload.title,
        category: payload.category,
        content: payload.content,
        aiMeta: payload.aiMeta,
      });
      await refreshDiskNotes();
      return created;
    }

    const now = new Date().toISOString();
    const id = createUuid();
    const ensured = ensureBlockIds(payload.content);
    validateNoteAssetPaths(ensured);
    const {text} = extractPlainText(ensured);
    const normalized = text.replace(/\s+/g, ' ').trim();
    const wordCount = normalized ? normalized.split(/\s+/).length : 0;
    const hash = await computeCanonicalContentHash(ensured);
    const fileName = `ai-${id.slice(0, 8)}.json`;

    const created: StoredNoteEntry = {
      fileName,
      pillar: 'ai',
      path: `ai/${fileName}`,
      excerpt: (normalized || 'AI synthesis note.').slice(0, 180),
      wordCount,
      note: {
        id,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        title: payload.title,
        category: payload.category,
        pillar: 'ai',
        createdAt: now,
        updatedAt: now,
        contentHash: hash,
        content: ensured,
        aiMeta: payload.aiMeta,
      },
    };
    const updatedList = [created, ...notesRef.current];
    notesRef.current = updatedList;
    setNotes(updatedList);
    void triggerIndexSync(updatedList, sourceDocumentsRef.current);
    return created;
  };

  const handleSaveEditorNote = async (
    entry: StoredNoteEntry,
    patch: {title: string; category: Category; content: TipTapDoc},
  ): Promise<StoredNoteEntry> => {
    if (connectionState === 'connected') {
      const updated = await updateNote(entry.pillar, entry.fileName, patch);
      const nextList = notesRef.current.map((item) =>
        item.note.id === updated.note.id ? updated : item,
      );
      setNotes(nextList);
      setSelectedEntry((prev) =>
        prev && prev.note.id === updated.note.id ? updated : prev,
      );
      setExternalConflict((prev) =>
        prev && prev.noteId === updated.note.id ? null : prev,
      );
      void triggerIndexSync(nextList, sourceDocumentsRef.current);
      return updated;
    }

    const ensured = ensureBlockIds(patch.content);
    validateNoteAssetPaths(ensured);
    const {text} = extractPlainText(ensured);
    const normalized = text.replace(/\s+/g, ' ').trim();
    const wordCount = normalized ? normalized.split(/\s+/).length : 0;
    const hash = await computeCanonicalContentHash(ensured);

    const updated: StoredNoteEntry = {
      ...entry,
      excerpt: (normalized || 'Empty note.').slice(0, 180),
      wordCount,
      note: {
        ...entry.note,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        title: patch.title,
        category: patch.category,
        updatedAt: new Date().toISOString(),
        contentHash: hash,
        content: ensured,
      },
    };
    await syncNoteAssetsIndex(updated.note.id, ensured);
    const nextList = notesRef.current.map((item) =>
      item.note.id === entry.note.id ? updated : item,
    );
    setNotes(nextList);
    setSelectedEntry((prev) =>
      prev && prev.note.id === updated.note.id ? updated : prev,
    );
    setExternalConflict((prev) =>
      prev && prev.noteId === updated.note.id ? null : prev,
    );
    void triggerIndexSync(nextList, sourceDocumentsRef.current);
    return updated;
  };

  const handleReloadExternal = () => {
    if (!externalConflict) {
      return;
    }
    setSelectedEntry(externalConflict.diskEntry);
    setExternalConflict(null);
    setReloadVersion((prev) => prev + 1);
  };

  const handleKeepMineExternal = () => {
    setExternalConflict(null);
  };

  const handleDeleteNote = async (
    entry: StoredNoteEntry,
    orphanAssetsToDelete: string[] = [],
  ) => {
    if (connectionState === 'connected') {
      await deleteNote(entry.pillar, entry.fileName);
      if (orphanAssetsToDelete.length > 0) {
        await deleteAssetsFromWorkspace(orphanAssetsToDelete);
      }
      await refreshDiskNotes();
    } else {
      const nextList = notesRef.current.filter(
        (item) => item.note.id !== entry.note.id,
      );
      setNotes(nextList);
      await removeNoteFromAssetsIndex(entry.note.id);
      if (orphanAssetsToDelete.length > 0) {
        await deleteAssetsFromWorkspace(orphanAssetsToDelete);
      }
      void triggerIndexSync(nextList, sourceDocumentsRef.current);
    }
    setExternalConflict(null);
    setSelectedEntry(null);
    setTargetBlockId(null);
  };

  const handleResetFilters = () => {
    setActiveCategory('All');
    setSearchQuery('');
  };

  const handleDownloadModel = async () => {
    try {
      const config = await initializeLocalEmbeddingModel(
        embeddingConfig.modelId,
      );
      setEmbeddingConfig(config);
      embeddingConfigRef.current = config;
      await syncLocalSearchIndex({
        notes: notesRef.current,
        sources: sourceDocumentsRef.current,
        computeVectors: true,
        modelId: config.modelId,
      });
    } catch {
      // Cancelled or surfaced via embeddingProgress
    }
  };

  const handleCancelModelWork = () => {
    cancelEmbeddingDownloadOrIndexing();
  };

  const handleChangeModelId = async (nextModelId: string) => {
    const wasDownloaded = embeddingConfig.isDownloaded;
    const {config} = await ensureModelIdConsistency(nextModelId);
    setEmbeddingConfig(config);
    embeddingConfigRef.current = config;
    if (wasDownloaded) {
      try {
        const downloaded = await initializeLocalEmbeddingModel(nextModelId);
        setEmbeddingConfig(downloaded);
        embeddingConfigRef.current = downloaded;
        await syncLocalSearchIndex({
          notes: notesRef.current,
          sources: sourceDocumentsRef.current,
          computeVectors: true,
          modelId: downloaded.modelId,
        });
      } catch {
        // Cancelled or surfaced via embeddingProgress
      }
    }
  };

  // Debounced cross-folder local search (Web Worker cosine similarity or word-match fallback)
  useEffect(() => {
    const q = localSearchQuery.trim();
    if (!q) {
      setSearchResults([]);
      setSearching(false);
      setSearchMode(
        aiEnabled && embeddingConfig.isDownloaded ? 'semantic' : 'word-match',
      );
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchWorkspaceBlocks({
        query: q,
        notes,
        sources: sourceDocuments,
        aiEnabled,
        topK: 12,
      })
        .then((res) => {
          if (!cancelled) {
            setSearchMode(res.mode);
            setSearchResults(res.results);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSearchResults([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setSearching(false);
          }
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    aiEnabled,
    embeddingConfig.isDownloaded,
    localSearchQuery,
    notes,
    sourceDocuments,
  ]);

  // ---------- EXPERIMENTAL VOICE SEARCH (LOCAL WHISPER WORKER + KILL SWITCH + OPTIONAL PORCUPINE) ----------

  const applyTranscriptToSemanticSearch = useCallback(
    async (transcript: string) => {
      const cleaned = transcript.trim();
      if (!cleaned) {
        return;
      }
      setVoiceRuntime((prev) => ({
        ...prev,
        lastTranscript: cleaned,
        lastError: null,
      }));
      setLocalSearchQuery(cleaned);
      if (route !== '/workspace') {
        setSelectedEntry(null);
        setSelectedSourceDoc(null);
        setTargetBlockId(null);
        navigate('/workspace');
      } else if (selectedEntryRef.current || selectedSourceDocRef.current) {
        setSelectedEntry(null);
        setSelectedSourceDoc(null);
        setTargetBlockId(null);
      }
    },
    [navigate, route],
  );

  const handleUpdateVoiceSettings = useCallback(
    async (patch: Partial<VoiceSearchSettings>) => {
      const merged: VoiceSearchSettings = {
        ...voiceSettingsRef.current,
        ...patch,
      };
      if (!merged.experimentalVoiceEnabled) {
        merged.wakeWordEnabled = false;
      }
      const saved = await saveVoiceSearchSettings(merged);
      setVoiceSettings(saved);
      voiceSettingsRef.current = saved;
      setVoiceRuntime((prev) => ({
        ...prev,
        phase: saved.experimentalVoiceEnabled ? 'idle' : 'off',
        lastError: null,
      }));
    },
    [],
  );

  const handleDownloadWhisperModel = useCallback(async () => {
    const current = voiceSettingsRef.current;
    setVoiceRuntime((prev) => ({
      ...prev,
      phase: 'loading-model',
      lastError: null,
    }));
    try {
      await initializeWhisperModel(
        current.whisperModelId,
        current.whisperDownloaded,
      );
      const updated = await saveVoiceSearchSettings({
        ...voiceSettingsRef.current,
        whisperDownloaded: true,
      });
      setVoiceSettings(updated);
      voiceSettingsRef.current = updated;
      setVoiceRuntime((prev) => ({
        ...prev,
        phase: updated.experimentalVoiceEnabled ? 'idle' : 'off',
        lastError: null,
      }));
    } catch (err) {
      setVoiceRuntime((prev) => ({
        ...prev,
        phase: voiceSettingsRef.current.experimentalVoiceEnabled
          ? 'error'
          : 'off',
        lastError:
          (err as Error).message || 'Could not initialize Whisper model.',
      }));
    }
  }, []);

  const handleStartPushToTalk = useCallback(async () => {
    if (!voiceSettingsRef.current.experimentalVoiceEnabled) {
      return;
    }
    if (activeCaptureRef.current) {
      return;
    }
    setVoiceRuntime((prev) => ({
      ...prev,
      phase: 'listening',
      lastError: null,
    }));
    try {
      const handle = await startEphemeralMicCapture();
      activeCaptureRef.current = handle;
      const perm = await queryMicrophonePermissionState();
      setVoiceRuntime((prev) => ({...prev, micPermissionState: perm}));
    } catch (err) {
      activeCaptureRef.current = null;
      hotkeyHeldRef.current = false;
      setVoiceRuntime((prev) => ({
        ...prev,
        phase: 'error',
        lastError:
          (err as Error).message || 'Microphone permission denied or unavailable.',
      }));
    }
  }, []);

  const handleStopPushToTalk = useCallback(async () => {
    const handle = activeCaptureRef.current;
    hotkeyHeldRef.current = false;
    if (!handle) {
      setVoiceRuntime((prev) => ({
        ...prev,
        phase: voiceSettingsRef.current.experimentalVoiceEnabled ? 'idle' : 'off',
      }));
      return;
    }
    activeCaptureRef.current = null;

    setVoiceRuntime((prev) => ({...prev, phase: 'transcribing'}));
    let samples16k: Float32Array | null = null;
    try {
      samples16k = await handle.stopAndExtract16k();
      if (samples16k.length < 1600) {
        setVoiceRuntime((prev) => ({
          ...prev,
          phase: voiceSettingsRef.current.experimentalVoiceEnabled
            ? 'idle'
            : 'off',
          lastError: 'Hold push-to-talk slightly longer while speaking.',
        }));
        return;
      }

      const transcript = await transcribeEphemeralAudio({
        samples16k,
        modelId: voiceSettingsRef.current.whisperModelId,
      });

      if (!voiceSettingsRef.current.whisperDownloaded) {
        const saved = await saveVoiceSearchSettings({
          ...voiceSettingsRef.current,
          whisperDownloaded: true,
        });
        setVoiceSettings(saved);
        voiceSettingsRef.current = saved;
      }

      if (transcript) {
        await applyTranscriptToSemanticSearch(transcript);
      } else {
        setVoiceRuntime((prev) => ({
          ...prev,
          lastError: 'No speech detected in audio.',
        }));
      }
      setVoiceRuntime((prev) => ({
        ...prev,
        phase: voiceSettingsRef.current.experimentalVoiceEnabled
          ? 'idle'
          : 'off',
      }));
    } catch (err) {
      setVoiceRuntime((prev) => ({
        ...prev,
        phase: voiceSettingsRef.current.experimentalVoiceEnabled
          ? 'error'
          : 'off',
        lastError: (err as Error).message || 'Local Whisper transcription failed.',
      }));
    } finally {
      if (samples16k) {
        samples16k.fill(0);
      }
    }
  }, [applyTranscriptToSemanticSearch]);

  const handleMasterKillSwitch = useCallback(async (): Promise<KillSwitchReport> => {
    hotkeyHeldRef.current = false;
    if (activeCaptureRef.current) {
      const cap = activeCaptureRef.current;
      activeCaptureRef.current = null;
      await cap.discard().catch(() => undefined);
    }
    cancelWhisperWork();
    await stopPorcupineWakeWord().catch(() => undefined);
    const report = await killAllMicrophoneAccess();

    const offSettings = await saveVoiceSearchSettings({
      ...voiceSettingsRef.current,
      experimentalVoiceEnabled: false,
      wakeWordEnabled: false,
    });
    setVoiceSettings(offSettings);
    voiceSettingsRef.current = offSettings;

    setVoiceRuntime((prev) => ({
      ...prev,
      phase: 'off',
      activeTrackCount: report.remainingActiveTracks,
      micPermissionState: report.permissionState,
      wakeWordActive: false,
      wakeWordStatusMessage: 'Stopped by Master Kill Switch',
      lastError: null,
    }));
    return report;
  }, []);

  // In-app push-to-talk hotkey listener (strictly active ONLY when experimentalVoiceEnabled is true & tab focused)
  useEffect(() => {
    if (!voiceSettings.experimentalVoiceEnabled) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }
      if (
        matchesPushToTalkHotkey(
          event,
          voiceSettingsRef.current.pushToTalkHotkey,
          event.target,
        )
      ) {
        event.preventDefault();
        if (!hotkeyHeldRef.current) {
          hotkeyHeldRef.current = true;
          void handleStartPushToTalk();
        }
      }
    };

    const releaseHeld = () => {
      if (hotkeyHeldRef.current || activeCaptureRef.current) {
        hotkeyHeldRef.current = false;
        void handleStopPushToTalk();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!hotkeyHeldRef.current) {
        return;
      }
      const parts = voiceSettingsRef.current.pushToTalkHotkey.split('+');
      const mainKey = parts[parts.length - 1];
      if (
        matchesPushToTalkHotkey(
          event,
          voiceSettingsRef.current.pushToTalkHotkey,
        ) ||
        event.code === mainKey ||
        event.key === 'Alt' ||
        event.key === 'Control' ||
        event.key === 'Shift' ||
        event.key === 'Meta'
      ) {
        releaseHeld();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseHeld);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseHeld);
    };
  }, [
    handleStartPushToTalk,
    handleStopPushToTalk,
    voiceSettings.experimentalVoiceEnabled,
  ]);

  // Step 2 (Optional): Picovoice Porcupine wake word lifecycle (strictly OFF unless explicitly enabled with AccessKey)
  useEffect(() => {
    if (
      !voiceSettings.experimentalVoiceEnabled ||
      !voiceSettings.wakeWordEnabled ||
      !porcupineAccessKey.trim()
    ) {
      void stopPorcupineWakeWord().then(() => {
        setVoiceRuntime((prev) => ({
          ...prev,
          wakeWordActive: false,
          wakeWordStatusMessage: voiceSettings.wakeWordEnabled
            ? 'Requires AccessKey'
            : 'Inactive',
        }));
      });
      return;
    }

    let cancelled = false;
    setVoiceRuntime((prev) => ({
      ...prev,
      wakeWordStatusMessage: `Starting "${voiceSettings.wakeWordKeyword}" wake word…`,
      lastError: null,
    }));

    void startPorcupineWakeWord({
      accessKey: porcupineAccessKey,
      keyword: voiceSettings.wakeWordKeyword,
      onDetected: () => {
        if (cancelled) return;
        void (async () => {
          setVoiceRuntime((prev) => ({
            ...prev,
            phase: 'listening',
            wakeWordStatusMessage: `Wake word detected ("${voiceSettings.wakeWordKeyword}"). Listening…`,
          }));
          let utterance: Float32Array | null = null;
          try {
            utterance = await captureUtteranceAfterWakeWord({
              maxDurationMs: 4500,
              silenceWindowMs: 1100,
            });
            if (utterance.length >= 1600) {
              setVoiceRuntime((prev) => ({...prev, phase: 'transcribing'}));
              const transcript = await transcribeEphemeralAudio({
                samples16k: utterance,
                modelId: voiceSettingsRef.current.whisperModelId,
              });
              if (transcript) {
                await applyTranscriptToSemanticSearch(transcript);
              }
            }
          } catch (err) {
            if (!cancelled) {
              setVoiceRuntime((prev) => ({
                ...prev,
                lastError: (err as Error).message || 'Wake capture failed.',
              }));
            }
          } finally {
            if (utterance) {
              utterance.fill(0);
            }
            if (!cancelled) {
              setVoiceRuntime((prev) => ({
                ...prev,
                phase: voiceSettingsRef.current.experimentalVoiceEnabled
                  ? 'wake-listening'
                  : 'off',
                wakeWordStatusMessage: `Listening for "${voiceSettingsRef.current.wakeWordKeyword}"`,
              }));
            }
          }
        })();
      },
      onError: (msg) => {
        if (!cancelled) {
          setVoiceRuntime((prev) => ({
            ...prev,
            wakeWordActive: false,
            lastError: msg,
            wakeWordStatusMessage: 'Wake word error',
          }));
        }
      },
    })
      .then(async () => {
        if (cancelled) {
          await stopPorcupineWakeWord();
          return;
        }
        const perm = await queryMicrophonePermissionState();
        setVoiceRuntime((prev) => ({
          ...prev,
          phase: 'wake-listening',
          micPermissionState: perm,
          wakeWordActive: true,
          wakeWordStatusMessage: `Listening for "${voiceSettings.wakeWordKeyword}"`,
          lastError: null,
        }));
      })
      .catch((err) => {
        if (!cancelled) {
          setVoiceRuntime((prev) => ({
            ...prev,
            wakeWordActive: false,
            lastError:
              (err as Error).message || 'Failed to start Porcupine wake word.',
            wakeWordStatusMessage: 'Failed to start',
          }));
          void saveVoiceSearchSettings({
            ...voiceSettingsRef.current,
            wakeWordEnabled: false,
          }).then((saved) => {
            setVoiceSettings(saved);
            voiceSettingsRef.current = saved;
          });
        }
      });

    return () => {
      cancelled = true;
      void stopPorcupineWakeWord();
    };
  }, [
    applyTranscriptToSemanticSearch,
    porcupineAccessKey,
    voiceSettings.experimentalVoiceEnabled,
    voiceSettings.wakeWordEnabled,
    voiceSettings.wakeWordKeyword,
  ]);

  const activeDocMeta = useMemo(() => {
    if (selectedEntry) {
      return {
        id: selectedEntry.note.id,
        pillar: selectedEntry.pillar,
        title: selectedEntry.note.title,
      };
    }
    if (selectedSourceDoc) {
      return {
        id: selectedSourceDoc.id,
        pillar: 'sources' as const,
        title: selectedSourceDoc.title,
      };
    }
    return null;
  }, [selectedEntry, selectedSourceDoc]);

  const refreshActiveConnections = useCallback(
    async (
      meta: {id: string; pillar: 'sources' | 'manual' | 'ai'; title: string} | null,
    ) => {
      if (!meta) {
        setBacklinks([]);
        setSuggestions([]);
        setSuggestionsLoading(false);
        return;
      }
      setSuggestionsLoading(true);
      try {
        const [docBacklinks, suggestedOut] = await Promise.all([
          getBacklinksForDocument(meta.id),
          findSuggestedConnections({
            fromNoteId: meta.id,
            fromPillar: meta.pillar,
            fromTitle: meta.title,
            notes: notesRef.current,
            sources: sourceDocumentsRef.current,
            aiEnabled: aiEnabledRef.current,
            topK: 5,
          }),
        ]);
        setBacklinks(docBacklinks);
        setSuggestionMode(suggestedOut.mode);
        setSuggestions(suggestedOut.suggestions);
      } catch {
        setSuggestions([]);
      } finally {
        setSuggestionsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void refreshActiveConnections(activeDocMeta);
  }, [
    activeDocMeta,
    aiEnabled,
    embeddingConfig.isDownloaded,
    notes,
    refreshActiveConnections,
    sourceDocuments,
  ]);

  const handleNavigateToBlock = useCallback(
    (noteId: string, blockId: string, kind: 'note' | 'source') => {
      setExternalConflict(null);
      if (kind === 'source') {
        const doc = sourceDocumentsRef.current.find((d) => d.id === noteId);
        if (doc) {
          setSelectedEntry(null);
          setSelectedSourceDoc(doc);
          setTargetBlockId(blockId);
          if (route !== '/workspace') {
            navigate('/workspace');
          }
          return;
        }
      }

      const entry = notesRef.current.find((n) => n.note.id === noteId);
      if (entry) {
        setSelectedSourceDoc(null);
        setSelectedEntry(entry);
        setTargetBlockId(blockId);
        if (route !== '/workspace') {
          navigate('/workspace');
        }
      }
    },
    [navigate, route],
  );

  const handleLinkSuggestion = async (
    suggestion: SuggestedConnection,
    sourceBlockId?: string,
  ) => {
    if (!activeDocMeta) {
      return;
    }
    const fallbackBlock =
      selectedEntry?.note.content.content?.[0]?.attrs &&
      typeof selectedEntry.note.content.content[0].attrs.id === 'string'
        ? selectedEntry.note.content.content[0].attrs.id
        : selectedSourceDoc?.chunks[0]?.blockId || activeDocMeta.id;

    await linkSuggestedConnection({
      suggestion,
      sourceBlockId: sourceBlockId || fallbackBlock,
      sourceTitle: activeDocMeta.title,
    });
    await refreshActiveConnections(activeDocMeta);
  };

  const handleDismissSuggestion = async (suggestion: SuggestedConnection) => {
    await dismissConnection(suggestion);
    await refreshActiveConnections(activeDocMeta);
  };

  const handleRemoveBacklink = async (backlinkId: string) => {
    await removeExplicitBacklink(backlinkId);
    await refreshActiveConnections(activeDocMeta);
  };

  return (
    <>
      {route === '/' ? (
        <SetupPage
          connectionState={connectionState}
          folderName={folderName}
          errorMessage={pickerError}
          busy={workspaceBusy}
          onSelectFolder={handleSelectFolder}
          onReconnect={handleReconnect}
          onForgetWorkspace={handleForgetWorkspace}
          onNavigate={navigate}
        />
      ) : (
        <div className="flex h-screen w-full overflow-hidden bg-[#0C0D10] text-[#ECEBE6]">
          <Sidebar
            route={route}
            activePillar={activePillar}
            counts={pillarCounts}
            mobileOpen={mobileSidebarOpen}
            onCloseMobile={() => setMobileSidebarOpen(false)}
            onSelectPillar={(pillar) => {
              setActivePillar(pillar);
              setExternalConflict(null);
              setSelectedEntry(null);
              setSelectedSourceDoc(null);
              setTargetBlockId(null);
            }}
            onNavigate={(nextRoute) => {
              setExternalConflict(null);
              setSelectedEntry(null);
              setSelectedSourceDoc(null);
              setTargetBlockId(null);
              navigate(nextRoute);
            }}
          />

          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <TopBar
              folderName={folderName}
              connectionState={connectionState}
              scanning={scanning}
              searchQuery={searchQuery}
              onSearchChange={(q) => {
                setSearchQuery(q);
                setExternalConflict(null);
                setSelectedEntry(null);
                setSelectedSourceDoc(null);
                setTargetBlockId(null);
                if (route !== '/workspace' && q.trim()) {
                  navigate('/workspace');
                }
              }}
              aiEnabled={aiEnabled}
              onToggleAi={() => setAiEnabled((prev) => !prev)}
              miniNotebookOpen={miniNotebookOpen}
              onToggleMiniNotebook={() => setMiniNotebookOpen((prev) => !prev)}
              aiChatOpen={aiChatOpen}
              onToggleAiChat={() => setAiChatOpen((prev) => !prev)}
              onOpenKeySetup={() => setKeySetupOpen(true)}
              onOpenNewNote={() => setNewNoteOpen(true)}
              onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
              onReconnect={handleReconnect}
              onRescan={() => void runWorkspaceScan('manual', {force: true})}
              onNavigate={(nextRoute) => {
                setExternalConflict(null);
                setSelectedEntry(null);
                setSelectedSourceDoc(null);
                setTargetBlockId(null);
                navigate(nextRoute);
              }}
            />

            <main className="min-h-0 flex-1 overflow-y-auto">
              {route === '/workspace' && selectedSourceDoc ? (
                <SourceDocumentView
                  doc={selectedSourceDoc}
                  targetBlockId={targetBlockId}
                  backlinks={backlinks}
                  suggestions={suggestions}
                  suggestionMode={suggestionMode}
                  suggestionsLoading={suggestionsLoading}
                  onBack={() => {
                    setSelectedSourceDoc(null);
                    setTargetBlockId(null);
                  }}
                  onLinkSuggestion={(suggestion) =>
                    void handleLinkSuggestion(suggestion)
                  }
                  onDismissSuggestion={(suggestion) =>
                    void handleDismissSuggestion(suggestion)
                  }
                  onRemoveBacklink={(id) => void handleRemoveBacklink(id)}
                  onNavigateToBlock={handleNavigateToBlock}
                />
              ) : route === '/workspace' && selectedEntry ? (
                <NoteEditorView
                  entry={selectedEntry}
                  targetBlockId={targetBlockId}
                  reloadVersion={reloadVersion}
                  externalConflict={
                    externalConflict?.noteId === selectedEntry.note.id
                      ? externalConflict
                      : null
                  }
                  aiChatOpen={aiChatOpen}
                  onToggleAiChat={() => setAiChatOpen((prev) => !prev)}
                  backlinks={backlinks}
                  suggestions={suggestions}
                  suggestionMode={suggestionMode}
                  suggestionsLoading={suggestionsLoading}
                  onReloadExternal={handleReloadExternal}
                  onKeepMineExternal={handleKeepMineExternal}
                  onLinkSuggestion={(suggestion, sourceBlockId) =>
                    void handleLinkSuggestion(suggestion, sourceBlockId)
                  }
                  onDismissSuggestion={(suggestion) =>
                    void handleDismissSuggestion(suggestion)
                  }
                  onRemoveBacklink={(id) => void handleRemoveBacklink(id)}
                  onNavigateToBlock={handleNavigateToBlock}
                  onBack={() => {
                    setExternalConflict(null);
                    setSelectedEntry(null);
                    setTargetBlockId(null);
                  }}
                  onSaveNote={handleSaveEditorNote}
                  onDeleteNote={handleDeleteNote}
                />
              ) : route === '/workspace' ? (
                <WorkspacePage
                  notes={notes}
                  sourceDocuments={sourceDocuments}
                  problems={scanProblems}
                  scanning={scanning}
                  activePillar={activePillar}
                  activeCategory={activeCategory}
                  searchQuery={searchQuery}
                  localSearchQuery={localSearchQuery}
                  searching={searching}
                  searchMode={searchMode}
                  searchResults={searchResults}
                  aiEnabled={aiEnabled}
                  embeddingConfig={embeddingConfig}
                  embeddingProgress={embeddingProgress}
                  voiceSettings={voiceSettings}
                  voiceRuntime={voiceRuntime}
                  whisperProgress={whisperProgress}
                  onStartPushToTalk={() => void handleStartPushToTalk()}
                  onStopPushToTalk={() => void handleStopPushToTalk()}
                  onMasterKillSwitch={() => void handleMasterKillSwitch()}
                  onNavigate={navigate}
                  connectionState={connectionState}
                  folderName={folderName}
                  busy={workspaceBusy}
                  onSelectCategory={setActiveCategory}
                  onSearchChange={setSearchQuery}
                  onLocalSearchChange={setLocalSearchQuery}
                  onResetFilters={handleResetFilters}
                  onOpenNote={(entry) => {
                    setExternalConflict(null);
                    setSelectedSourceDoc(null);
                    setTargetBlockId(null);
                    setSelectedEntry(entry);
                  }}
                  onOpenSourceDoc={(doc) => {
                    setExternalConflict(null);
                    setSelectedEntry(null);
                    setTargetBlockId(null);
                    setSelectedSourceDoc(doc);
                  }}
                  onOpenSearchResult={(result) =>
                    handleNavigateToBlock(
                      result.noteId,
                      result.blockId,
                      result.kind,
                    )
                  }
                  onDownloadModel={() => void handleDownloadModel()}
                  onCancelModelWork={handleCancelModelWork}
                  onChangeModelId={(id) => void handleChangeModelId(id)}
                  onOpenNewNote={() => setNewNoteOpen(true)}
                  onImportMarkdown={handleImportMarkdown}
                  onImportDemoPdf={handleImportDemoPdf}
                  onReconnect={handleReconnect}
                  onRescan={() => void runWorkspaceScan('manual', {force: true})}
                  onSelectFolder={handleSelectFolder}
                />
              ) : null}
              {route === '/workspace/study' && (
                <StudyPage
                  notes={notes}
                  sourceDocuments={sourceDocuments}
                  aiEnabled={aiEnabled}
                  onNavigateToBlock={handleNavigateToBlock}
                  onNavigate={navigate}
                />
              )}
              {route === '/workspace/synthesizer' && (
                <SynthesizerPage
                  notes={notes}
                  sourceDocuments={sourceDocuments}
                  aiEnabled={aiEnabled}
                  onOpenKeySetup={() => setKeySetupOpen(true)}
                  onNavigateToBlock={handleNavigateToBlock}
                  onSaveAiNote={handleSaveAiNote}
                  onNavigate={navigate}
                />
              )}
              {route === '/workspace/gap-analysis' && (
                <GapAnalysisPage
                  notes={notes}
                  sourceDocuments={sourceDocuments}
                  aiEnabled={aiEnabled}
                  onNavigate={navigate}
                  onNavigateToBlock={handleNavigateToBlock}
                  onOpenNewNote={() => setNewNoteOpen(true)}
                  onOpenKeySetup={() => setKeySetupOpen(true)}
                />
              )}
              {route === '/workspace/organize' && (
                <OrganizePage
                  notes={notes}
                  onRefreshWorkspace={async () => {
                    await runWorkspaceScan('manual', {force: true});
                  }}
                  onNavigate={navigate}
                />
              )}
              {route === '/workspace/trust-tuning' && (
                <TrustTuningPage onNavigate={navigate} />
              )}
              {route === '/settings' && (
                <SettingsPage
                  voiceSettings={voiceSettings}
                  voiceRuntime={voiceRuntime}
                  whisperProgress={whisperProgress}
                  porcupineAccessKey={porcupineAccessKey}
                  onChangePorcupineAccessKey={setPorcupineAccessKey}
                  onUpdateVoiceSettings={handleUpdateVoiceSettings}
                  onMasterKillSwitch={handleMasterKillSwitch}
                  onDownloadWhisperModel={handleDownloadWhisperModel}
                  onCancelWhisperWork={cancelWhisperWork}
                  onNavigate={navigate}
                />
              )}
              {route === '/diagnostics' && (
                <DiagnosticsPage
                  notes={notes}
                  sourceDocuments={sourceDocuments}
                  onNavigate={navigate}
                />
              )}
            </main>

            <AiChatPanel
              isOpen={aiChatOpen}
              onClose={() => setAiChatOpen(false)}
              activeNote={selectedEntry}
              onNavigateToBlock={handleNavigateToBlock}
              onSaveToAi={handleSaveAiNote}
              onOpenKeySetup={() => setKeySetupOpen(true)}
            />
          </div>

          <MiniNotebook
            open={miniNotebookOpen}
            onClose={() => setMiniNotebookOpen(false)}
            onSaveToManual={handleCreateManualNote}
          />

          <NewNoteModal
            open={newNoteOpen}
            isPersisted={connectionState === 'connected'}
            onClose={() => setNewNoteOpen(false)}
            onCreate={handleCreateManualNote}
          />

          <KeySetupModal
            open={keySetupOpen}
            onClose={() => setKeySetupOpen(false)}
          />
        </div>
      )}

      <NonEmptyFolderModal
        open={pendingInit !== null}
        folderName={pendingInit?.inspection.folderName ?? ''}
        entryCount={pendingInit?.inspection.entryCount ?? 0}
        onCancel={() => {
          setPendingInit(null);
          setConnectionState(
            restoredHandle ? 'restored-needs-permission' : 'unselected',
          );
        }}
        onConfirm={async () => {
          if (pendingInit) {
            await finalizeFolderConnection(pendingInit.handle);
          }
        }}
      />
    </>
  );
}

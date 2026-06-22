import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AddPlus,
  Camera,
  CloseMd,
  FileDocument,
  Image01,
  Loading,
  TrashFull,
} from 'react-coolicons';
import {
  createNoteImageSignedUrl,
  deleteNoteImage,
  getImageDimensions,
  listNoteImages,
  NOTE_IMAGE_ACCEPT,
  normalizeAttachmentMimeType,
  type NoteImage,
  type PendingNoteImage,
  uploadNoteImage,
  validateNoteImageFile,
} from '../lib/noteImages';

type AttachmentMode = 'pending' | 'saved';

interface NoteImageAttachmentsProps {
  mode: AttachmentMode;
  noteId?: string | null;
  userId?: string | null;
  pendingImages?: PendingNoteImage[];
  disabled?: boolean;
  compact?: boolean;
  showCountButton?: boolean;
  showTitle?: boolean;
  showToolbar?: boolean;
  showGallery?: boolean;
  showManageButton?: boolean;
  className?: string;
  onPendingImagesAdd?: (images: PendingNoteImage[]) => void;
  onPendingImageRemove?: (imageId: string) => void;
  onImagesChange?: (images: NoteImage[]) => void;
}

function formatImageSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageAttachment(attachment: Pick<NoteImage, 'mime_type'> | Pick<PendingNoteImage, 'mimeType'>): boolean {
  const mimeType = 'mimeType' in attachment ? attachment.mimeType : attachment.mime_type;
  return mimeType.startsWith('image/');
}

function dataUrlToFile(dataUrl: string, fileName: string): File {
  const [header, data] = dataUrl.split(',');
  const mimeType = header.match(/data:(.*);base64/)?.[1] || 'image/jpeg';
  const bytes = atob(data);
  const buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) buffer[i] = bytes.charCodeAt(i);
  return new File([buffer], fileName, { type: mimeType });
}

async function filesToPendingImages(files: File[]): Promise<PendingNoteImage[]> {
  const pending: PendingNoteImage[] = [];

  for (const file of files) {
    const validationError = validateNoteImageFile(file);
    const dimensions = validationError || !file.type.startsWith('image/') ? null : await getImageDimensions(file);
    pending.push({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
      mimeType: normalizeAttachmentMimeType(file),
      sizeBytes: file.size,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      status: validationError ? 'error' : 'pending',
      error: validationError,
    });
  }

  return pending;
}

export default function NoteImageAttachments({
  mode,
  noteId,
  userId,
  pendingImages = [],
  disabled = false,
  compact = false,
  showCountButton = true,
  showTitle = true,
  showToolbar = true,
  showGallery = true,
  showManageButton = false,
  className = '',
  onPendingImagesAdd,
  onPendingImageRemove,
  onImagesChange,
}: NoteImageAttachmentsProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onImagesChangeRef = useRef(onImagesChange);
  const imageFallbackLoadingRef = useRef<Set<string>>(new Set());
  const [savedImages, setSavedImages] = useState<NoteImage[]>([]);
  const [loadingSavedImages, setLoadingSavedImages] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingImageId, setDeletingImageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerImage, setViewerImage] = useState<NoteImage | PendingNoteImage | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const images = mode === 'saved' ? savedImages : pendingImages;
  const countLabel = `${images.length} attachment${images.length === 1 ? '' : 's'}`;
  const canWriteSavedImages = mode === 'saved' && Boolean(noteId && userId) && !disabled;
  const canAdd = mode === 'pending' ? !disabled : canWriteSavedImages;
  const settingsLayout = mode === 'pending' && compact;

  useEffect(() => {
    onImagesChangeRef.current = onImagesChange;
  }, [onImagesChange]);

  useEffect(() => {
    let cancelled = false;
    const shouldLoadSavedImages = showGallery || showCountButton || showTitle || showManageButton;
    if (mode !== 'saved' || !noteId || !shouldLoadSavedImages) return;

    setLoadingSavedImages(true);
    setError(null);
    listNoteImages(noteId)
      .then((rows) => {
        if (cancelled) return;
        setSavedImages(rows);
        onImagesChangeRef.current?.(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load attachments.');
      })
      .finally(() => {
        if (!cancelled) setLoadingSavedImages(false);
      });

    return () => {
      cancelled = true;
    };
  }, [mode, noteId, showCountButton, showGallery, showManageButton, showTitle]);

  useEffect(() => {
    if (!cameraOpen) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, [cameraOpen]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    if (manageOpen && images.length === 0) setManageOpen(false);
  }, [images.length, manageOpen]);

  const visibleImages = useMemo(() => images.slice(0, compact ? 4 : 8), [compact, images]);

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setError(null);

    if (mode === 'pending') {
      onPendingImagesAdd?.(await filesToPendingImages(files));
      return;
    }

    if (!noteId || !userId) return;
    setUploading(true);
    try {
      const uploaded: NoteImage[] = [];
      for (const file of files) {
        const validationError = validateNoteImageFile(file);
        if (validationError) throw new Error(validationError);
        const dimensions = file.type.startsWith('image/') ? await getImageDimensions(file) : null;
        uploaded.push(await uploadNoteImage({
          file,
          noteId,
          userId,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
        }));
      }
      const next = [...savedImages, ...uploaded];
      setSavedImages(next);
      onImagesChange?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add attachments.');
    } finally {
      setUploading(false);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void addFiles(files);
  };

  const handleDeleteSavedImage = async (image: NoteImage) => {
    setDeletingImageId(image.id);
    setError(null);
    try {
      await deleteNoteImage(image);
      const next = savedImages.filter((item) => item.id !== image.id);
      setSavedImages(next);
      onImagesChange?.(next);
      if (viewerImage?.id === image.id) setViewerImage(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove attachment.');
    } finally {
      setDeletingImageId(null);
    }
  };

  const openCamera = async () => {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraInputRef.current?.click();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      streamRef.current = stream;
      setCameraOpen(true);
      window.setTimeout(() => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      }, 0);
    } catch (err) {
      setCameraError(err instanceof Error ? err.message : 'Camera is not available.');
      cameraInputRef.current?.click();
    }
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const file = dataUrlToFile(canvas.toDataURL('image/jpeg', 0.9), `photo-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`);
    setCameraOpen(false);
    void addFiles([file]);
  };

  const openAttachment = (image: NoteImage | PendingNoteImage) => {
    if (!isImageAttachment(image)) {
      if ('previewUrl' in image) {
        window.open(image.previewUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      void createNoteImageSignedUrl(image)
        .then((signedUrl) => window.open(signedUrl, '_blank', 'noopener,noreferrer'))
        .catch((err) => setError(err instanceof Error ? err.message : 'Could not open attachment.'));
      return;
    }

    if ('previewUrl' in image || image.signedUrl) {
      setViewerImage(image);
      return;
    }

    setViewerImage({ ...image, signedUrl: image.thumbnailSignedUrl || '' });
    void createNoteImageSignedUrl(image)
      .then((signedUrl) => {
        setViewerImage((current) => (current?.id === image.id && !('previewUrl' in current) ? { ...current, signedUrl } : current));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load full-size image.'));
  };

  const loadOriginalImageFallback = (image: NoteImage | PendingNoteImage) => {
    if (!isImageAttachment(image)) return;
    if ('previewUrl' in image || image.signedUrl || imageFallbackLoadingRef.current.has(image.id)) return;
    imageFallbackLoadingRef.current.add(image.id);
    void createNoteImageSignedUrl(image)
      .then((signedUrl) => {
        setSavedImages((prev) => {
          const next = prev.map((item) => (item.id === image.id ? { ...item, signedUrl, thumbnailSignedUrl: signedUrl } : item));
          onImagesChangeRef.current?.(next);
          return next;
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load attachment.'))
      .finally(() => {
        imageFallbackLoadingRef.current.delete(image.id);
      });
  };

  return (
    <div className={`note-image-attachments ${compact ? 'note-image-attachments-compact' : ''} ${settingsLayout ? 'note-image-attachments-settings' : ''} ${className}`}>
      <input
        ref={fileInputRef}
        type="file"
        accept={NOTE_IMAGE_ACCEPT}
        multiple
        className="hidden"
        onChange={handleFileChange}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileChange}
      />

      {showToolbar ? (
      <div className={`note-image-toolbar ${settingsLayout ? 'note-image-toolbar-settings' : ''}`}>
        {showCountButton && !settingsLayout ? (
          <button
            type="button"
            className="summary-toolbar-btn note-image-toolbar-button"
            onClick={() => {
              if (images.length > 0) openAttachment(images[0]);
              else if (canAdd) fileInputRef.current?.click();
            }}
            style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
            title={images.length > 0 ? 'View attachments' : 'Attach files'}
            aria-label={images.length > 0 ? 'View attachments' : 'Attach files'}
          >
            <Image01 className="h-3.5 w-3.5" aria-hidden />
            <span>{countLabel}</span>
          </button>
        ) : !settingsLayout && showTitle ? (
          <div className="note-image-tab-title">
            <Image01 className="h-4 w-4" aria-hidden />
            <span>{countLabel}</span>
          </div>
        ) : null}
        {canAdd ? (
          <>
            <button
              type="button"
              className="summary-toolbar-btn note-image-toolbar-button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              title="Attach files"
              aria-label="Attach files"
            >
              {uploading ? <Loading className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <AddPlus className="h-3.5 w-3.5" aria-hidden />}
              <span>Attach</span>
            </button>
            <button
              type="button"
              className="summary-toolbar-btn note-image-toolbar-button"
              onClick={() => void openCamera()}
              disabled={uploading}
              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              title="Take photo"
              aria-label="Take photo"
            >
              <Camera className="h-3.5 w-3.5" aria-hidden />
              <span>Camera</span>
            </button>
            {(settingsLayout || showManageButton) && images.length > 0 ? (
              <button
                type="button"
                className="summary-toolbar-btn note-image-toolbar-button"
                onClick={() => setManageOpen(true)}
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                title="Manage attachments"
                aria-label="Manage attachments"
              >
                <Image01 className="h-3.5 w-3.5" aria-hidden />
                <span>Manage</span>
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      ) : null}

      {loadingSavedImages && showGallery && !settingsLayout ? (
        <div className="note-image-loading" style={{ color: 'var(--text-secondary)' }}>
          <Loading className="h-4 w-4 animate-spin" aria-hidden />
          <span>Loading attachments...</span>
        </div>
      ) : null}

      {!loadingSavedImages && images.length > 0 && showGallery && !settingsLayout ? (
        <div className="note-image-strip custom-scrollbar">
          {visibleImages.map((image) => {
            const src = 'previewUrl' in image ? image.previewUrl : image.thumbnailSignedUrl || image.signedUrl;
            const isPendingError = 'status' in image && image.status === 'error';
            return (
              <div key={image.id} className={`note-image-thumb ${isPendingError ? 'note-image-thumb-error' : ''}`}>
                <button
                  type="button"
                  className="note-image-thumb-preview"
                  onClick={() => openAttachment(image)}
                  disabled={!src}
                  title={image.name}
                >
                  {src && isImageAttachment(image) ? (
                    <img src={src} alt={image.name} onError={() => loadOriginalImageFallback(image)} />
                  ) : !isImageAttachment(image) ? (
                    <FileDocument className="h-5 w-5" aria-hidden />
                  ) : (
                    <Image01 className="h-5 w-5" aria-hidden />
                  )}
                </button>
                {mode === 'pending' ? (
                  <button
                    type="button"
                    className="note-image-thumb-remove"
                    onClick={() => onPendingImageRemove?.(image.id)}
                    title="Remove attachment"
                    aria-label="Remove attachment"
                  >
                    <CloseMd className="h-3 w-3" aria-hidden />
                  </button>
                ) : canWriteSavedImages ? (
                  <button
                    type="button"
                    className="note-image-thumb-remove"
                    onClick={() => void handleDeleteSavedImage(image as NoteImage)}
                    disabled={deletingImageId === image.id}
                    title="Remove attachment"
                    aria-label="Remove attachment"
                  >
                    {deletingImageId === image.id ? (
                      <Loading className="h-3 w-3 animate-spin" aria-hidden />
                    ) : (
                      <TrashFull className="h-3 w-3" aria-hidden />
                    )}
                  </button>
                ) : null}
              </div>
            );
          })}
          {images.length > visibleImages.length ? (
            <button type="button" className="note-image-more" onClick={() => openAttachment(images[visibleImages.length])}>
              +{images.length - visibleImages.length}
            </button>
          ) : null}
        </div>
      ) : null}

      {error || cameraError ? (
        <div className="note-image-status" style={{ color: error || cameraError ? 'var(--error)' : 'var(--text-muted)' }}>
          {error || cameraError}
        </div>
      ) : null}

      {viewerImage ? (
        <div className="app-modal-backdrop" role="presentation" onClick={() => setViewerImage(null)}>
          <div className="app-modal-panel note-image-preview-modal" role="dialog" aria-modal="true" aria-label="Attachment preview" onClick={(event) => event.stopPropagation()}>
            <div className="app-modal-header">
              <div className="min-w-0">
                <h3 className="app-modal-title">{viewerImage.name}</h3>
                <p className="app-modal-subtitle">
                  {'sizeBytes' in viewerImage ? formatImageSize(viewerImage.sizeBytes) : formatImageSize(viewerImage.size_bytes)}
                </p>
              </div>
              <button type="button" className="app-modal-close" onClick={() => setViewerImage(null)} aria-label="Close attachment preview">
                <CloseMd className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="app-modal-body note-image-preview-body">
              <img
                src={'previewUrl' in viewerImage ? viewerImage.previewUrl : viewerImage.signedUrl}
                alt={viewerImage.name}
              />
            </div>
          </div>
        </div>
      ) : null}

      {manageOpen ? (
        <div className="app-modal-backdrop" role="presentation" onClick={() => setManageOpen(false)}>
          <div className="app-modal-panel note-image-manage-modal" role="dialog" aria-modal="true" aria-label="Manage attachments" onClick={(event) => event.stopPropagation()}>
            <div className="app-modal-header">
              <div className="min-w-0">
                <h3 className="app-modal-title">Attachments</h3>
                <p className="app-modal-subtitle">
                  {mode === 'pending' ? 'Preview, add, or remove files before generating.' : 'Preview, add, or remove files attached to this note.'}
                </p>
              </div>
              <button type="button" className="app-modal-close" onClick={() => setManageOpen(false)} aria-label="Close attachments">
                <CloseMd className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="app-modal-body note-image-manage-body">
              <div className="note-image-manage-actions">
                <button
                  type="button"
                  className="summary-toolbar-btn note-image-toolbar-button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!canAdd || uploading}
                >
                  <AddPlus className="h-3.5 w-3.5" aria-hidden />
                  Attach
                </button>
                <button
                  type="button"
                  className="summary-toolbar-btn note-image-toolbar-button"
                  onClick={() => void openCamera()}
                  disabled={!canAdd || uploading}
                >
                  <Camera className="h-3.5 w-3.5" aria-hidden />
                  Camera
                </button>
              </div>
              <div className="note-image-manage-grid">
                {images.map((image) => {
                  const src = 'previewUrl' in image ? image.previewUrl : image.thumbnailSignedUrl || image.signedUrl;
                  const isPendingError = 'status' in image && image.status === 'error';
                  return (
                    <div key={image.id} className={`note-image-manage-item ${isPendingError ? 'note-image-thumb-error' : ''}`}>
                      <button type="button" className="note-image-manage-preview" onClick={() => openAttachment(image)} disabled={!src}>
                        {src && isImageAttachment(image) ? (
                          <img src={src} alt={image.name} onError={() => loadOriginalImageFallback(image)} />
                        ) : !isImageAttachment(image) ? (
                          <FileDocument className="h-5 w-5" aria-hidden />
                        ) : (
                          <Image01 className="h-5 w-5" aria-hidden />
                        )}
                      </button>
                      <div className="note-image-manage-meta">
                        <span title={image.name}>{image.name}</span>
                        <button
                          type="button"
                          onClick={() => {
                            if (mode === 'pending') onPendingImageRemove?.(image.id);
                            else void handleDeleteSavedImage(image as NoteImage);
                          }}
                          title="Remove attachment"
                          aria-label="Remove attachment"
                        >
                          <TrashFull className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {cameraOpen ? (
        <div className="app-modal-backdrop" role="presentation" onClick={() => setCameraOpen(false)}>
          <div className="app-modal-panel note-image-camera-modal" role="dialog" aria-modal="true" aria-label="Take a photo" onClick={(event) => event.stopPropagation()}>
            <div className="app-modal-header">
              <div>
                <h3 className="app-modal-title">Take photo</h3>
                <p className="app-modal-subtitle">Use your camera for a quick meeting note attachment.</p>
              </div>
              <button type="button" className="app-modal-close" onClick={() => setCameraOpen(false)} aria-label="Close camera">
                <CloseMd className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="app-modal-body note-image-camera-body">
              <video ref={videoRef} autoPlay playsInline muted className="note-image-camera-preview" />
            </div>
            <div className="app-modal-footer">
              <button type="button" className="summary-toolbar-btn" onClick={() => setCameraOpen(false)}>
                Cancel
              </button>
              <button type="button" className="summary-toolbar-btn note-image-primary-action" onClick={capturePhoto}>
                <Camera className="h-4 w-4" aria-hidden />
                Capture
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

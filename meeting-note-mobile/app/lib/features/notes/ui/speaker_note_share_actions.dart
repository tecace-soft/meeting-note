import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/i18n/app_strings.dart';
import '../data/notes_repository.dart';
import '../models/meeting_note.dart';

class SpeakerNoteShareOffer {
  const SpeakerNoteShareOffer({
    required this.name,
    required this.segmentIndexes,
    this.microsoftId,
  });
  final String name;
  final String? microsoftId;
  final List<int> segmentIndexes;
  bool appliesTo(List<TranscriptSegment> segments) => segmentIndexes.any(
    (i) => i >= 0 && i < segments.length && segments[i].speaker == name,
  );
}

/// The assignment is already saved; sharing is always a separate user action.
class SpeakerNoteShareActions extends ConsumerStatefulWidget {
  const SpeakerNoteShareActions({
    super.key,
    required this.note,
    required this.offers,
    required this.onShared,
    required this.onSelectTarget,
  });
  final MeetingNote note;
  final List<SpeakerNoteShareOffer> offers;
  final ValueChanged<List<String>> onShared;
  final Future<void> Function() onSelectTarget;
  @override
  ConsumerState<SpeakerNoteShareActions> createState() =>
      _SpeakerNoteShareActionsState();
}

class _SpeakerNoteShareActionsState
    extends ConsumerState<SpeakerNoteShareActions> {
  String? _owner;
  String? _error;
  bool _loaded = false;
  bool _busy = false;
  List<String> _shared = [];
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant SpeakerNoteShareActions oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.note.sharedUserIds != widget.note.sharedUserIds) {
      _shared = List.of(widget.note.sharedUserIds);
    }
  }

  Future<void> _load() async {
    try {
      final repository = ref.read(notesRepositoryProvider);
      final userId = await repository.currentUserId();
      final sharing = await repository.getNoteSharing(widget.note.id);
      if (userId == null || sharing.ownerId != userId) {
        throw StateError('Only the note owner can share this note.');
      }
      if (!mounted) return;
      setState(() {
        _owner = userId;
        _shared = sharing.sharedUsers?.whereType<String>().toList() ?? [];
        _loaded = true;
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = '$error';
          _loaded = true;
        });
      }
    }
  }

  Future<void> _share(SpeakerNoteShareOffer offer) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final noteId = widget.note.id;
    bool current() =>
        mounted &&
        widget.note.id == noteId &&
        widget.offers.contains(offer) &&
        offer.appliesTo(widget.note.transcript);
    try {
      final repository = ref.read(notesRepositoryProvider);
      if (offer.microsoftId == null) {
        final sharing = await repository.getNoteSharing(noteId);
        final userId = await repository.currentUserId();
        if (sharing.ownerId != userId) {
          throw StateError('Only the note owner can share this note.');
        }
        if (!current()) return;
        await widget.onSelectTarget();
      } else {
        final ids = await repository.shareNoteWithMicrosoftUser(
          noteId,
          offer.microsoftId!,
          isCurrent: current,
        );
        if (!current()) return;
        setState(() => _shared = ids);
        widget.onShared(ids);
      }
    } catch (error) {
      if (current()) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(appTextProvider);
    final seen = <String>{};
    final offers = widget.offers.where(
      (offer) =>
          offer.appliesTo(widget.note.transcript) &&
          offer.microsoftId != _owner &&
          seen.add(offer.microsoftId ?? 'name:${offer.name}'),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_loaded && _owner != null)
          for (final offer in offers)
            Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 8,
              children: [
                Text(offer.name),
                if (offer.microsoftId != null &&
                    _shared.contains(offer.microsoftId))
                  Text(t('note.alreadyShared'))
                else
                  TextButton(
                    onPressed: _busy ? null : () => _share(offer),
                    child: Text(
                      t(
                        offer.microsoftId == null
                            ? 'note.selectSharingTarget'
                            : 'note.shareWithThisPerson',
                      ),
                    ),
                  ),
              ],
            ),
        if (_error != null) ...[
          Text(
            _error!,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
          if (_owner == null)
            TextButton(
              onPressed: _busy ? null : _load,
              child: Text(t('common.tryAgain')),
            ),
        ],
      ],
    );
  }
}

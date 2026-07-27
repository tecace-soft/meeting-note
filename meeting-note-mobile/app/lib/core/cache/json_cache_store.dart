import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

class JsonCacheStore {
  const JsonCacheStore(this.namespace);

  final String namespace;

  Future<List<dynamic>?> readList(String key) async {
    final data = await _read(key);
    return data is List ? data : null;
  }

  Future<Map<String, dynamic>?> readMap(String key) async {
    final data = await _read(key);
    return data is Map ? data.cast<String, dynamic>() : null;
  }

  Future<void> writeList(String key, List<dynamic> value) => _write(key, value);

  Future<void> writeMap(String key, Map<String, dynamic> value) =>
      _write(key, value);

  Future<void> delete(String key) async {
    final file = await _file(key);
    if (await file.exists()) await file.delete();
  }

  Future<dynamic> _read(String key) async {
    try {
      final file = await _file(key);
      if (!await file.exists()) return null;
      return jsonDecode(await file.readAsString());
    } catch (_) {
      return null;
    }
  }

  Future<void> _write(String key, Object value) async {
    final file = await _file(key);
    await file.parent.create(recursive: true);
    await file.writeAsString(jsonEncode(value), flush: true);
  }

  Future<File> _file(String key) async {
    final dir = await getApplicationSupportDirectory();
    return File('${dir.path}/cache/$namespace/${_clean(key)}.json');
  }

  String _clean(String value) =>
      value.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]+'), '_');
}

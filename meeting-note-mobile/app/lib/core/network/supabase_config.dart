const supabaseUrl = String.fromEnvironment(
  'SUPABASE_URL',
  defaultValue: 'https://smnnlamrwisqaquymsdl.supabase.co',
);

const supabaseAnonKey = String.fromEnvironment(
  'SUPABASE_ANON_KEY',
  defaultValue: 'sb_publishable_xkdZSukdjjCSwD4TCuKrgA_Qnhz0h4D',
);

bool get isSupabaseConfigured =>
    supabaseUrl.isNotEmpty &&
    supabaseAnonKey.isNotEmpty &&
    !supabaseUrl.contains('placeholder');

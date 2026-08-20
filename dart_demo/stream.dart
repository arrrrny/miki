// Stand-in for `dart test` — same streaming shape (lines arrive over time),
// no pub get required. Run with: dart run dart_demo/stream.dart
// Over WSS this streams stdout frames one at a time, like a real test run.
void main() async {
  final suites = ['counter_test', 'string_test', 'math_test'];
  for (var i = 0; i < suites.length; i++) {
    final n = i + 1;
    final name = suites[i];
    await Future.delayed(const Duration(milliseconds: 350));
    print('00:0$n +$i -0: $name');
    await Future.delayed(const Duration(milliseconds: 250));
    print('  ok');
  }
  print('');
  print('All tests passed!');
}

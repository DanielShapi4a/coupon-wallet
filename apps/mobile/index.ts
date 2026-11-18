// SPIKE 02 (spike/fcm only): the background task must be defined in a module that loads first, even
// when the app starts in the background with no screen; expo-router loads its routes only to render.
import './src/spike/fcm';
import 'expo-router/entry';

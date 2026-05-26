// Test-fixture island map. Mirrors the union of demo islands + the
// extras only the integration suite needs (NoteForm/AvatarUpload/WhoAmI
// for the actions tests).
export default {
  islands: {
    Counter: '../../../example/hello-world/components/Counter.tsx',
    NoteForm: './components/NoteForm.tsx',
    AvatarUpload: './components/AvatarUpload.tsx',
    WhoAmI: './components/WhoAmI.tsx',
  },
}

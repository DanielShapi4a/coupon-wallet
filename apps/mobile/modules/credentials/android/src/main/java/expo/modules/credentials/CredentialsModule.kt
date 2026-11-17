package expo.modules.credentials

import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Our own thin bridge to Android Credential Manager (decision 041): Sign in with Google now,
// and the silent passkey check (prepareGetCredential, decision 035) in sub-step 3.
class CredentialsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Credentials")

    // Shows Google's account picker and returns a Google ID token for the server to verify.
    // webClientId is the Web OAuth client: the audience the server checks.
    // ponytail: no nonce yet; add one from the server if ID-token replay becomes a concern.
    AsyncFunction("signInWithGoogle") Coroutine { webClientId: String ->
      val activity = appContext.currentActivity
        ?: throw CodedException("ERR_NO_ACTIVITY", "No activity to show the sign-in on", null)
      val request = GetCredentialRequest.Builder()
        .addCredentialOption(GetSignInWithGoogleOption.Builder(webClientId).build())
        .build()

      val credential = try {
        CredentialManager.create(activity).getCredential(activity, request).credential
      } catch (e: GetCredentialCancellationException) {
        throw CodedException("ERR_CANCELED", "Sign-in was canceled", e)
      } catch (e: NoCredentialException) {
        throw CodedException("ERR_NO_CREDENTIAL", "No Google account available for sign-in", e)
      } catch (e: GetCredentialException) {
        throw CodedException("ERR_SIGN_IN", e.message ?: e.type, e)
      }

      if (credential is CustomCredential && credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
        GoogleIdTokenCredential.createFrom(credential.data).idToken
      } else {
        throw CodedException("ERR_UNEXPECTED_CREDENTIAL", "Unexpected credential type: ${credential.type}", null)
      }
    }
  }
}

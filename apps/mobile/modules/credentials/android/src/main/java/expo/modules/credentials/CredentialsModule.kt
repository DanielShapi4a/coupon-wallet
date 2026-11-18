package expo.modules.credentials

import android.os.Build
import android.util.Base64
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.SecureRandom
import org.json.JSONArray
import org.json.JSONObject

// Our own thin bridge to Android Credential Manager (decision 041): Sign in with Google,
// and the silent passkey check (decision 035). Also hides the app from the recent-apps view (RED-7).
class CredentialsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Credentials")

    // RED-7 (decision 042): no app preview in the recent-apps view. Unlike FLAG_SECURE, the user can
    // still take screenshots. Android 13+ (API 33); the app's minimum is 14 (decision 037).
    // ponytail: set once at startup; if the activity is ever recreated, also call it from OnActivityEntersForeground.
    Function("hideFromRecents") {
      val activity = appContext.currentActivity
      activity?.runOnUiThread { activity.setRecentsScreenshotEnabled(false) }
      activity != null
    }

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

    // Decision 035: checks, without showing anything, whether the vault's passkey still exists.
    // prepareGetCredential only looks the credential up; nothing is signed and no UI appears.
    // Android 14+ (API 34), which is also the app's minimum (decision 037).
    AsyncFunction("hasPasskey") Coroutine { rpId: String, credentialId: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        throw CodedException("ERR_UNSUPPORTED", "The silent passkey check needs Android 14 or later", null)
      }
      val context = appContext.reactContext
        ?: throw CodedException("ERR_NO_CONTEXT", "No context for Credential Manager", null)

      val challenge = ByteArray(32).also { SecureRandom().nextBytes(it) }
      val requestJson = JSONObject()
        .put("challenge", Base64.encodeToString(challenge, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP))
        .put("rpId", rpId)
        .put("allowCredentials", JSONArray().put(JSONObject().put("type", "public-key").put("id", credentialId)))
        .put("userVerification", "required")
        .toString()
      val request = GetCredentialRequest.Builder()
        .addCredentialOption(GetPublicKeyCredentialOption(requestJson))
        .build()

      val response = try {
        CredentialManager.create(context).prepareGetCredential(request)
      } catch (e: GetCredentialException) {
        throw CodedException("ERR_CHECK", e.message ?: e.type, e)
      }
      response.hasCredentialResults(PublicKeyCredential.TYPE_PUBLIC_KEY_CREDENTIAL)
    }
  }
}

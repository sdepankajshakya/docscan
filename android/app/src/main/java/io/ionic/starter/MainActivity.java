package com.docscan.app;

import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    
    /**
     * Called when the activity is first created.
     * This is where we initialize the navigation bar appearance.
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setSystemBarsForTheme(); // Apply initial system bar styling
        setupSystemUiListener(); // Set up listener to maintain styling
    }
    
    /**
     * Called when the activity becomes visible to the user.
     * Necessary because some system events or dialogs can reset navigation bar appearance.
     */
    @Override
    public void onResume() {
        super.onResume();
        setSystemBarsForTheme(); // Re-apply based on current theme
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        setSystemBarsForTheme();
    }
    
    /**
     * Called when the window gains or loses focus (e.g., when user returns from notification shade).
     * This ensures navigation bar stays correct even after system UI interactions.
     */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            setSystemBarsForTheme(); // Re-apply when window regains focus
        }
    }
    
    /**
     * Sets up a listener that monitors system UI visibility changes.
     * Android may change system UI flags when entering immersive mode, showing keyboard, etc.
     * This listener re-applies our navigation bar settings whenever the system UI changes.
     */
    private void setupSystemUiListener() {
        final View decorView = getWindow().getDecorView();
        decorView.setOnSystemUiVisibilityChangeListener(new View.OnSystemUiVisibilityChangeListener() {
            @Override
            public void onSystemUiVisibilityChange(int visibility) {
                setSystemBarsForTheme(); // Re-apply when system UI changes
            }
        });
    }
    
    /**
     * Sets the navigation bar to white background with dark buttons.
     * This ensures navigation buttons (back, home, multitasking) are visible.
     * 
     * Uses different APIs depending on Android version:
     * - Android 11+ (API 30+): Uses WindowInsetsController (modern API)
     * - Android 8-10 (API 26-29): Uses deprecated systemUiVisibility flags
     * - Android 5+ (API 21+): Can set navigation bar color
     */
    private boolean isDarkModeEnabled() {
        int nightModeFlags = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return nightModeFlags == Configuration.UI_MODE_NIGHT_YES;
    }

    private void setSystemBarsForTheme() {
        Window window = getWindow();
        boolean isDarkMode = isDarkModeEnabled();
        int darkSurfaceColor = 0xFF121212;
        int lightSurfaceColor = 0xFFFFFFFF;
        
        // Set status and navigation bar background colors
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            int systemBarColor = isDarkMode ? darkSurfaceColor : lightSurfaceColor;
            window.setNavigationBarColor(systemBarColor);
            window.setStatusBarColor(systemBarColor);
        }
        
        // For Android 11 and above - use modern WindowInsetsController API
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS;

                if (isDarkMode) {
                    // Dark background -> light icons
                    controller.setSystemBarsAppearance(0, mask);
                } else {
                    // Light background -> dark icons
                    controller.setSystemBarsAppearance(mask, mask);
                }
            }
        } 
        // For Android 8.0 to 10 - use deprecated but still functional systemUiVisibility flags
        else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            View decorView = window.getDecorView();
            int flags = decorView.getSystemUiVisibility();

            if (isDarkMode) {
                // Dark background -> clear light flags to use light icons
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            } else {
                // Light background -> set light flags to use dark icons
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            }

            decorView.setSystemUiVisibility(flags);
        }
    }
}


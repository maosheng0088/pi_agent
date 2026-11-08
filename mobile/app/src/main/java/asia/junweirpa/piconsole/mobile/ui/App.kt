package asia.junweirpa.piconsole.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Work
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import asia.junweirpa.piconsole.mobile.MainViewModel

@Composable
fun MobileApp(vm: MainViewModel) {
    when (vm.phase) {
        MainViewModel.Phase.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        MainViewModel.Phase.Login -> LoginScreen(vm)
        MainViewModel.Phase.Home -> {
            val session = vm.openSession
            if (session != null) {
                ChatScreen(vm, session)
            } else {
                HomeShell(vm)
            }
        }
    }
}

@Composable
private fun HomeShell(vm: MainViewModel) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(vm.notice) {
        vm.notice?.let {
            snackbar.showSnackbar(it)
            vm.clearNotice()
        }
    }
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = vm.tab == 0,
                    onClick = { vm.tab = 0 },
                    icon = { Icon(Icons.Default.Groups, null) },
                    label = { Text("会话") },
                )
                NavigationBarItem(
                    selected = vm.tab == 1,
                    onClick = { vm.tab = 1 },
                    icon = { Icon(Icons.Default.Work, null) },
                    label = { Text("工作台") },
                )
                NavigationBarItem(
                    selected = vm.tab == 2,
                    onClick = { vm.tab = 2 },
                    icon = { Icon(Icons.Default.Person, null) },
                    label = { Text("我的") },
                )
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize()) {
            when (vm.tab) {
                0 -> SessionListScreen(vm, padding)
                1 -> WorkbenchScreen(vm, padding)
                else -> ProfileScreen(vm, padding)
            }
        }
    }
}
package org.mcmanager.viaproxy;

import net.lenni0451.lambdaevents.EventHandler;
import net.raphimc.viaproxy.ViaProxy;
import net.raphimc.viaproxy.plugins.ViaProxyPlugin;
import net.raphimc.viaproxy.plugins.events.JoinServerRequestEvent;

/**
 * ViaProxy kicks Bedrock players joining an online-mode Java server when
 * auth-method is NONE. Floodgate on the Java server is the real authenticator;
 * cancelling JoinServerRequestEvent lets that handshake complete.
 */
public class FloodgateJoinPlugin extends ViaProxyPlugin {
  @Override
  public void onEnable() {
    ViaProxy.EVENT_MANAGER.register(this);
  }

  @EventHandler
  public void onJoinServerRequest(JoinServerRequestEvent event) {
    event.setCancelled(true);
  }
}

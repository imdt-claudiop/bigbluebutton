import React, { useEffect } from 'react';
import { useConnectionState } from '@livekit/components-react';
import { ConnectionState, RoomEvent } from 'livekit-client';
import logger from '/imports/startup/client/logger';
import { liveKitRoom } from '/imports/ui/services/livekit';
import { useMediaSubscriptions } from './hooks';

const SelectiveSubscription: React.FC = () => {
  const connectionState = useConnectionState(liveKitRoom);
  const { handleSubscriptionChanges } = useMediaSubscriptions(liveKitRoom);

  useEffect(() => {
    if (connectionState !== ConnectionState.Connected) return;

    handleSubscriptionChanges();
  }, [connectionState, handleSubscriptionChanges]);

  // Re-issue subscriptions after a reconnect. Under selective subscription
  // autoSubscribe is OFF, so a fresh room connection does not carry over
  // subscriptions - the viewer must re-subscribe to the senders it wants, or it
  // stays connected with no inbound audio (issue 25313). A forced full reconnect
  // (fatal-error recovery) yields fresh, unsubscribed publications that the
  // connectionState effect above re-subscribes; this also covers LiveKit's own
  // RoomEvent.Reconnected so re-subscription is re-evaluated either way.
  useEffect(() => {
    const onReconnected = () => {
      logger.info({ logCode: 'livekit_lk25313' }, '[LK25313] SelectiveSubscription: RoomEvent.Reconnected -> re-issue subscriptions');
      handleSubscriptionChanges();
    };

    liveKitRoom.on(RoomEvent.Reconnected, onReconnected);

    return () => {
      liveKitRoom.off(RoomEvent.Reconnected, onReconnected);
    };
  }, [handleSubscriptionChanges]);

  return null;
};

export default React.memo(SelectiveSubscription);

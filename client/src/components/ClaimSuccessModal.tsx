import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check } from "lucide-react";
import { SiFarcaster } from "react-icons/si";
import { sharePostClaim, MODAL_COPY } from "@/lib/share";
import type { RewardAsset } from "@shared/schema";

interface ClaimSuccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  rewards: RewardAsset[];
  txHash: string;
}

export function ClaimSuccessModal({ isOpen, onClose, rewards, txHash }: ClaimSuccessModalProps) {
  const formatRewardsSummary = () => {
    return rewards.map(r => `${r.formattedAmount} ${r.symbol}`).join(", ");
  };

  const getPrimaryReward = () => {
    if (rewards.length === 0) return { amount: "0", symbol: "WETH" };
    return { amount: rewards[0].formattedAmount, symbol: rewards[0].symbol };
  };

  const handleShare = async () => {
    const primary = getPrimaryReward();
    await sharePostClaim(primary.amount);
  };

  const handleViewTransaction = () => {
    window.open(`https://basescan.org/tx/${txHash}`, "_blank");
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-center sm:text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
            <Check className="h-8 w-8 text-emerald-500" />
          </div>
          <DialogTitle className="text-xl">{MODAL_COPY.successTitle}</DialogTitle>
          <DialogDescription className="text-base">
            {MODAL_COPY.successDescription(formatRewardsSummary())}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 mt-4">
          <Button 
            onClick={handleShare} 
            className="w-full gap-2 bg-primary hover:bg-primary/90"
          >
            <SiFarcaster className="w-4 h-4" />
            {MODAL_COPY.shareButton}
          </Button>
          
          <Button
            variant="outline"
            onClick={handleViewTransaction}
            className="w-full gap-2"
          >
            {MODAL_COPY.viewTxButton}
          </Button>
          
          <Button
            variant="ghost"
            onClick={onClose}
            className="w-full text-muted-foreground"
          >
            {MODAL_COPY.doneButton}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

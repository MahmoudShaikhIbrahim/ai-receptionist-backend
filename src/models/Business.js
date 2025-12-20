const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const BusinessSchema = new mongoose.Schema(
  {
    /* ======================
       CORE IDENTITY
    ====================== */
    businessName: {
      type: String,
      required: true,
    },

    // Owner / account email
    email: {
      type: String,
      required: true,
      unique: true,
    },

    password: {
      type: String,
      required: true,
    },

    /* ======================
       CONTACT INFORMATION
    ====================== */
    ownerPhoneNumber: {
      type: String, // decision-maker contact
    },

    businessPhoneNumber: {
      type: String, // public-facing business number
    },
  },
  { timestamps: true }
);

/* ======================
   PASSWORD HASHING
====================== */
BusinessSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

/* ======================
   PASSWORD CHECK
====================== */
BusinessSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model("Business", BusinessSchema);